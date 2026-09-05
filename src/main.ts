import { Notice, Plugin } from 'obsidian';
import {
	createCalendarFeedId,
	DEFAULT_SETTINGS,
	TimeBlockSettings,
	TimeBlockSettingTab,
} from './settings';
import type { EventMapping } from './gcal/types';
import type { OAuthTokens } from './gcal/types';
import type { CalendarApiCallbacks } from './gcal/calendarApi';
import { runSync } from './gcal/syncEngine';
import { ScheduledBlock } from './types';
import {
	createDebouncedRunner,
	shouldAutoSync,
	type DebouncedRunner,
} from './utils/autoSync';
import { TIME_BLOCK_VIEW_TYPE, TimeBlockView } from './views/TimeBlockView';
import { DAY_VIEW_TYPE, DayView } from './views/DayView';

/** Delay before a block edit triggers an automatic calendar sync. */
const AUTO_SYNC_DELAY_MS = 3_000;

/** Interval between automatic remote GCal polls (milliseconds). */
const REMOTE_POLL_INTERVAL_MS = 30_000;

/** Shape of the unified data.json persisted by this plugin. */
interface PersistedData {
	version: number;
	settings: Partial<TimeBlockSettings>;
	blocks: ScheduledBlock[];
	/** Mappings between local blocks and Google Calendar events. */
	eventMappings?: EventMapping[];
}

export default class TimeBlockPlugin extends Plugin {
	settings: TimeBlockSettings = { ...DEFAULT_SETTINGS };
	blocks: ScheduledBlock[] = [];
	/** Persisted mappings linking blocks ↔ Google Calendar events. */
	eventMappings: EventMapping[] = [];
	/** Guard to prevent concurrent sync operations. */
	private syncing = false;
	/** The week currently on screen, used to target auto-sync. */
	currentWeekStart: string | null = null;
	/** Debounced auto-sync runner (batches rapid block edits). */
	private autoSync: DebouncedRunner = createDebouncedRunner(AUTO_SYNC_DELAY_MS);

	async onload(): Promise<void> {
		await this.loadSettings();

		// Register the weekly time-block view
		this.registerView(
			TIME_BLOCK_VIEW_TYPE,
			(leaf) => new TimeBlockView(leaf, this)
		);

		// Register the single-day sidebar view
		this.registerView(
			DAY_VIEW_TYPE,
			(leaf) => new DayView(leaf, this)
		);

		// Ribbon button
		this.addRibbonIcon('calendar-days', 'Open time blocks', () => {
			void this.activateView();
		});

		// Commands
		this.addCommand({
			id: 'open',
			name: 'Open weekly time-block view',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'open-day-view',
			name: 'Open day view in sidebar',
			callback: () => void this.activateDayView(),
		});

		this.addCommand({
			id: 'refresh',
			name: 'Refresh time-block view',
			callback: () => {
				const views = this.app.workspace
					.getLeavesOfType(TIME_BLOCK_VIEW_TYPE)
					.map((l) => l.view)
					.filter((v): v is TimeBlockView => v instanceof TimeBlockView);
				views.forEach((v) => { void v.refresh(); });
			},
		});

		this.addCommand({
			id: 'sync-calendar',
			name: 'Sync calendar events',
			callback: () => {
				const views = this.app.workspace
					.getLeavesOfType(TIME_BLOCK_VIEW_TYPE)
					.map((l) => l.view)
					.filter((v): v is TimeBlockView => v instanceof TimeBlockView);
				views.forEach((v) => { void v.triggerSync(); });
			},
		});

		// Settings tab
		this.addSettingTab(new TimeBlockSettingTab(this.app, this));

		// Periodic remote poll: pulls GCal changes every 30 seconds
		this.registerInterval(
			window.setInterval(() => {
				void this.pollRemoteChanges();
			}, REMOTE_POLL_INTERVAL_MS)
		);
	}

	onunload(): void {
		this.autoSync.cancel();
	}

	/** Opens (or focuses) the time-block view in a new tab. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(TIME_BLOCK_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: TIME_BLOCK_VIEW_TYPE, active: true });
		}
		void workspace.revealLeaf(leaf);
	}

	/** Opens (or focuses) the single-day view in the right sidebar. */
	async activateDayView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(DAY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('split');
			await leaf.setViewState({ type: DAY_VIEW_TYPE, active: true });
		}
		void workspace.revealLeaf(leaf);
	}

	// ── Two-way sync ──────────────────────────────────────────────────────────

	/**
	 * Builds the CalendarApiCallbacks object needed by the API client and sync
	 * engine, wiring token storage through the plugin's settings.
	 */
	buildApiCallbacks(): CalendarApiCallbacks {
		return {
			getTokens: () => this.settings.oauthTokens,
			saveTokens: async (tokens: OAuthTokens) => {
				this.settings.oauthTokens = tokens;
				await this.saveSettings();
			},
			clientId: this.settings.oauthClientId,
			clientSecret: this.settings.oauthClientSecret,
		};
	}

	/**
	 * Runs a two-way sync for the given week.
	 * Called from the view when the user triggers a sync (or automatically).
	 *
	 * When `silent` is true, user-facing Notices are suppressed (used by
	 * auto-sync); errors are still logged to the console.
	 */
	async syncWeek(weekStart: string, silent = false): Promise<boolean> {
		if (!this.settings.enableTwoWaySync) return false;
		if (!this.settings.oauthTokens) {
			if (!silent) {
				new Notice('Time blocks: sign in to your calendar account first.');
			}
			return false;
		}
		if (this.syncing) {
			if (!silent) {
				new Notice('Time blocks: sync already in progress.');
			}
			return false;
		}

		this.syncing = true;
		try {
			const result = await runSync(
				{
					api: this.buildApiCallbacks(),
					targetCalendarId: this.settings.syncCalendarId,
					conflictStrategy: this.settings.conflictStrategy,
					getBlocks: () => this.blocks,
					setBlocks: (blocks) => { this.blocks = blocks; },
					getMappings: () => this.eventMappings,
					saveMappings: async (mappings) => {
						this.eventMappings = mappings;
						await this.saveData(this.buildPayload());
					},
				},
				weekStart
			);

			if (result.errors.length > 0) {
				console.error('[Time Blocks] Sync errors:', result.errors);
			}

			const hasChanges = result.created > 0 || result.updated > 0 || result.deleted > 0;

			if (!silent) {
				// Summarize
				const parts: string[] = [];
				if (result.created > 0) parts.push(`${result.created} created`);
				if (result.updated > 0) parts.push(`${result.updated} updated`);
				if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
				if (result.conflicts.length > 0)
					parts.push(`${result.conflicts.length} conflicts`);
				if (result.errors.length > 0)
					parts.push(`${result.errors.length} errors`);

				const summary = parts.length > 0
					? `Sync complete: ${parts.join(', ')}.`
					: 'Sync complete: no changes.';
				new Notice(`Time blocks: ${summary}`);
			}

			return hasChanges;
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Schedules a debounced auto-sync for the currently-viewed week.
	 * Called after every block save; rapid edits batch into a single sync.
	 */
	private scheduleAutoSync(): void {
		const weekStart = this.currentWeekStart;
		if (!shouldAutoSync(
			this.settings.enableTwoWaySync,
			!!this.settings.oauthTokens,
			weekStart
		)) return;
		this.autoSync.schedule(() => {
			if (weekStart) {
				new Notice('Time blocks: auto-syncing calendar…');
				void this.syncWeek(weekStart, true);
			}
		});
	}

	/**
	 * Polls Google Calendar for remote changes and refreshes open views
	 * if any changes were detected. Called by the periodic interval timer.
	 */
	private async pollRemoteChanges(): Promise<void> {
		const weekStart = this.currentWeekStart;
		if (!shouldAutoSync(
			this.settings.enableTwoWaySync,
			!!this.settings.oauthTokens,
			weekStart
		)) return;

		const changed = await this.syncWeek(weekStart!, true);
		if (changed) {
			this.refreshOpenViews();
		}
	}

	/** Triggers a data refresh on all open Time Block and Day views. */
	private refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TIME_BLOCK_VIEW_TYPE)) {
			if (leaf.view instanceof TimeBlockView) {
				void (leaf.view as TimeBlockView).refresh();
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(DAY_VIEW_TYPE)) {
			if (leaf.view instanceof DayView) {
				void (leaf.view as DayView).refresh();
			}
		}
	}

	// ── Persistence ────────────────────────────────────────────────────────────

	/**
	 * Loads settings AND blocks from the shared data.json file.
	 * Must be called once from onload() before any view opens.
	 */
	async loadSettings(): Promise<void> {
		const raw = (await this.loadData() ?? {}) as Partial<PersistedData>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings ?? {});
		this.blocks = raw.blocks ?? [];
		this.eventMappings = raw.eventMappings ?? [];

		if (!Array.isArray(this.settings.calendarFeeds)) {
			this.settings.calendarFeeds = [];
		}

		interface LegacySettings extends Partial<TimeBlockSettings> {
			googleCalendarIcsUrl?: string;
		}
		const legacyUrl = (raw.settings as LegacySettings)?.googleCalendarIcsUrl;
		if (legacyUrl && this.settings.calendarFeeds.length === 0) {
			this.settings.calendarFeeds = [
				{ id: createCalendarFeedId(), url: legacyUrl },
			];
			await this.saveSettings();
		}
	}

	/** Saves only the settings portion (blocks are preserved). */
	async saveSettings(): Promise<void> {
		await this.saveData(this.buildPayload());
		this.notifySettingsChanged();
	}

	/** Notifies open views that settings changed, so they can rebuild the grid if needed. */
	private notifySettingsChanged(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TIME_BLOCK_VIEW_TYPE)) {
			if (leaf.view instanceof TimeBlockView) {
				(leaf.view as TimeBlockView).onSettingsChanged();
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(DAY_VIEW_TYPE)) {
			if (leaf.view instanceof DayView) {
				(leaf.view as DayView).onSettingsChanged();
			}
		}
	}

	/** Saves only the blocks portion (settings are preserved). */
	async saveBlocks(): Promise<void> {
		await this.saveData(this.buildPayload());
		this.scheduleAutoSync();
	}

	private buildPayload(): PersistedData {
		return {
			version: 1,
			settings: this.settings,
			blocks: this.blocks,
			eventMappings: this.eventMappings,
		};
	}
}
