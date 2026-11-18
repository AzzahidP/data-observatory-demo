// The autoplay story: one ~2-minute loop, the same on every screen.
// All timing lives here so it can be tuned in one place (BEST_PRACTICES §5).

export type SceneId = 'network' | 'split' | 'replay' | 'fragile';

export type Scene = {
    id: SceneId;
    start: number; // seconds into the loop
    duration: number; // seconds
    caption: string; // short description (for the preview and /control); no numbers here
};

export const SCENES: readonly Scene[] = [
    // 0:00 every dot one colour: it reads as an ordinary network map.
    { id: 'network', start: 0, duration: 15, caption: 'The network' },
    // 0:15 step-free stations turn teal, the rest dim to grey; headline appears.
    { id: 'split', start: 15, duration: 30, caption: 'Where you can step in' },
    // 0:45 the lift-outage window replays, sped up to 60 s.
    { id: 'replay', start: 45, duration: 60, caption: 'Does it work? Lift outages' },
    // 1:45 stations that depend on a single lift are outlined; then the loop restarts.
    { id: 'fragile', start: 105, duration: 15, caption: 'Stations that rely on one lift' }
];

export const LOOP_SECONDS = SCENES.reduce((end, s) => Math.max(end, s.start + s.duration), 0);

/** Seconds into the loop for a moment `nowMs`, given when the loop started. Always in [0, LOOP). */
export function loopSeconds(nowMs: number, startedAtMs: number) {
    const t = (nowMs - startedAtMs) / 1000;
    // `%` keeps the sign in JS, so add LOOP once more to handle a clock slightly behind startedAt.
    return ((t % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
}

/**
 * Seconds into the loop for a playhead that may be paused. Used by the screens (to draw)
 * and the bus (to apply play/pause/jump), so both agree on what "paused at 1:10" means.
 */
export function playheadSeconds(
    nowMs: number,
    timeline: { startedAt: number; pausedAt: number | null }
) {
    return loopSeconds(timeline.pausedAt ?? nowMs, timeline.startedAt);
}

/** Validates an untrusted timeline object (from the bus); null if any field is off. */
export function parseTimeline(
    value: unknown
): { startedAt: number; pausedAt: number | null } | null {
    if (typeof value !== 'object' || value === null) return null;
    const { startedAt, pausedAt } = value as { startedAt?: unknown; pausedAt?: unknown };
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
    if (pausedAt === null || pausedAt === undefined) return { startedAt, pausedAt: null };
    if (typeof pausedAt !== 'number' || !Number.isFinite(pausedAt)) return null;
    return { startedAt, pausedAt };
}

export function sceneAt(t: number): Scene {
    for (let i = SCENES.length - 1; i >= 0; i--) {
        if (t >= SCENES[i].start) return SCENES[i];
    }
    return SCENES[0];
}

/** How far through the replay scene we are, 0..1 (0 before it, 1 after it). */
export function replayProgress(t: number) {
    const replay = SCENES.find((s) => s.id === 'replay');
    if (!replay) return 0;
    return Math.min(1, Math.max(0, (t - replay.start) / replay.duration));
}

/** "1:05" style clock for dev overlays. */
export function formatClock(seconds: number) {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
