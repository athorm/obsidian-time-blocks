/**
 * Pure helpers for overlaying Google Calendar events onto the Time Blocks grid.
 *
 * Kept dependency-free so they can be unit-tested in isolation. Both
 * `TimeBlockView` and `DayView` use these to turn Google Calendar API events
 * into the app's internal `GCalEvent` shape, and to decide whether an API
 * fetch should run at all.
 */

import type { GCalEvent } from '../types';
import type { GoogleCalendarEvent } from './types';
import type { TimeBlockSettings } from '../settings';

/**
 * Converts Google Calendar API events into local `GCalEvent` objects.
 *
 * Rules:
 * - All-day events (`start.date` present, no `dateTime`) are skipped, matching
 *   the existing ICS behaviour where all-day events do not render on the grid.
 * - Cancelled events (`status === 'cancelled'`) are skipped.
 * - IDs are namespaced with `api::<calendarId>::<eventId>` to avoid collisions
 *   with events sourced from ICS feeds.
 * - Colors: the event's own `backgroundColor` wins; otherwise the calendar's
 *   default `calendarColor` is used; otherwise the field is left undefined so
 *   the renderer can fall back to the plugin setting.
 */
export function mapApiEventsToGCalEvents(
	events: GoogleCalendarEvent[],
	calendarId: string,
	calendarColor?: string
): GCalEvent[] {
	const result: GCalEvent[] = [];

	for (const event of events) {
		if (event.status === 'cancelled') continue;
		if (!event.start.dateTime || !event.end.dateTime) continue;

		result.push({
			id: `api::${calendarId}::${event.id}`,
			title: event.summary,
			start: new Date(event.start.dateTime),
			end: new Date(event.end.dateTime),
			isAllDay: false,
			description: event.description || undefined,
			location: event.location || undefined,
			color: event.backgroundColor ?? calendarColor,
		});
	}

	return result;
}

/**
 * Returns `true` when the Google Calendar API should be queried for overlay
 * events. Requires both an active OAuth session and at least one selected
 * calendar.
 */
export function shouldFetchApiCalendars(
	settings: Pick<TimeBlockSettings, 'oauthTokens' | 'selectedCalendarIds'>
): boolean {
	return (
		settings.oauthTokens !== null &&
		Array.isArray(settings.selectedCalendarIds) &&
		settings.selectedCalendarIds.length > 0
	);
}
