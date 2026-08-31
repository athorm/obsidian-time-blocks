import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createDebouncedRunner,
	shouldAutoSync,
} from '../../src/utils/autoSync';

describe('createDebouncedRunner', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs the callback once after the delay elapses', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		vi.advanceTimersByTime(2500);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does not fire before the delay elapses', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		vi.advanceTimersByTime(2999);
		expect(fn).not.toHaveBeenCalled();
	});

	it('collapses rapid schedule calls into a single run (trailing edge)', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		for (let i = 0; i < 5; i++) {
			runner.schedule(fn);
			vi.advanceTimersByTime(500);
		}
		// After 2500ms of repeated scheduling the timer keeps resetting.
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(3000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('resets the window when a new call arrives before the previous fires', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		vi.advanceTimersByTime(2500);
		runner.schedule(fn);

		// The first window would have fired at 3000ms; the second resets it.
		vi.advanceTimersByTime(500);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(2500);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does nothing when schedule is called with no pending work', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		vi.advanceTimersByTime(5000);
		expect(fn).not.toHaveBeenCalled();
	});

	it('cancel() drops a pending run', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		runner.cancel();

		vi.advanceTimersByTime(5000);
		expect(fn).not.toHaveBeenCalled();
	});

	it('cancel() after the run fired is a safe no-op', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		vi.advanceTimersByTime(3000);
		expect(fn).toHaveBeenCalledTimes(1);

		expect(() => runner.cancel()).not.toThrow();
	});

	it('a schedule after the previous run fired starts a fresh window', () => {
		const runner = createDebouncedRunner(3000);
		const fn = vi.fn();

		runner.schedule(fn);
		vi.advanceTimersByTime(3000);
		expect(fn).toHaveBeenCalledTimes(1);

		runner.schedule(fn);
		vi.advanceTimersByTime(1000);
		expect(fn).toHaveBeenCalledTimes(1); // not yet re-fired

		vi.advanceTimersByTime(2000);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('keeps runner instances isolated from each other', () => {
		const runnerA = createDebouncedRunner(3000);
		const runnerB = createDebouncedRunner(1000);
		const fnA = vi.fn();
		const fnB = vi.fn();

		runnerA.schedule(fnA);
		runnerB.schedule(fnB);

		vi.advanceTimersByTime(1000);
		expect(fnA).not.toHaveBeenCalled();
		expect(fnB).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2000);
		expect(fnA).toHaveBeenCalledTimes(1);
	});
});

describe('shouldAutoSync', () => {
	it('returns true only when sync is enabled, authenticated, and a week is visible', () => {
		expect(shouldAutoSync(true, true, '2025-07-14')).toBe(true);
	});

	it('returns false when two-way sync is disabled', () => {
		expect(shouldAutoSync(false, true, '2025-07-14')).toBe(false);
	});

	it('returns false when not authenticated (no tokens)', () => {
		expect(shouldAutoSync(true, false, '2025-07-14')).toBe(false);
	});

	it('returns false when no week is currently on screen', () => {
		expect(shouldAutoSync(true, true, null)).toBe(false);
	});

	it('returns false when multiple guards fail at once', () => {
		expect(shouldAutoSync(false, false, null)).toBe(false);
	});
});