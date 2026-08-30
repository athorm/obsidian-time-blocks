/**
 * Auto-sync helpers.
 *
 * Pure, framework-agnostic logic so the debounce behaviour and the
 * auto-sync guard can be unit tested without an Obsidian runtime.
 */

/** A debouncer that can be cancelled (e.g. on plugin unload). */
export interface DebouncedRunner {
	/** Schedules `run` to fire after the configured delay. Resets any pending call. */
	schedule(run: () => void): void;
	/** Cancels a pending run. Safe to call when nothing is scheduled. */
	cancel(): void;
}

/**
 * Creates a trailing-edge debouncer: repeated `schedule()` calls collapse
 * into a single `run()` fired after the last call's delay has elapsed.
 */
export function createDebouncedRunner(delayMs: number): DebouncedRunner {
	let timer: ReturnType<typeof setTimeout> | null = null;

	return {
		schedule(run: () => void) {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				run();
			}, delayMs);
		},
		cancel() {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}

/**
 * Returns true when auto-sync should be scheduled: two-way sync enabled,
 * an authenticated session, and a week currently on screen.
 */
export function shouldAutoSync(
	enabled: boolean,
	hasTokens: boolean,
	weekStart: string | null
): boolean {
	return enabled && hasTokens && weekStart !== null;
}