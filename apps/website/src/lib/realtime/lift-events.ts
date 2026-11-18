import type { LiftEvent, LiftWindow } from './types';

const LIFT_EVENTS_URL = '/data/lift-events.json';

let liftEventsRequest: Promise<unknown> | null = null;

/** Fetch `/data/lift-events.json` once and share the promise. Returns null on failure. */
export async function loadLiftEventsDataset(): Promise<unknown> {
    if (typeof window === 'undefined') return null;
    if (!liftEventsRequest) {
        liftEventsRequest = (async () => {
            try {
                const response = await fetch(LIFT_EVENTS_URL, {
                    headers: { accept: 'application/json' }
                });
                if (!response.ok) return null;
                return (await response.json()) as unknown;
            } catch {
                return null;
            }
        })();
    }
    const payload = await liftEventsRequest;
    if (payload === null) liftEventsRequest = null;
    return payload;
}

/**
 * Validate `{ version: 1, window: {start, end, seconds}, events: [...] }`.
 * Returns null if the window itself is unusable; bad events are dropped.
 */
export function parseLiftEvents(
    payload: unknown
): { window: LiftWindow; events: LiftEvent[] } | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const { version, window, events } = payload as Record<string, unknown>;
    if (version !== 1 || typeof window !== 'object' || window === null || !Array.isArray(events)) {
        return null;
    }
    const w = window as Record<string, unknown>;
    if (
        typeof w.start !== 'string' ||
        typeof w.end !== 'string' ||
        !Number.isInteger(w.seconds) ||
        (w.seconds as number) <= 0
    ) {
        return null;
    }
    const seconds = w.seconds as number;

    const parsed: LiftEvent[] = [];
    for (const item of events) {
        if (typeof item !== 'object' || item === null) continue;
        const e = item as Record<string, unknown>;
        if (
            typeof e.station !== 'string' ||
            typeof e.lift !== 'string' ||
            !isSecond(e.t0, seconds) ||
            !isSecond(e.t1, seconds) ||
            (e.t1 as number) < (e.t0 as number) ||
            !isFlag(e.startedBefore) ||
            !isFlag(e.stillOut) ||
            !isFlag(e.breaksRoute) ||
            !isFlag(e.allLost)
        ) {
            continue;
        }
        parsed.push({
            station: e.station,
            lift: e.lift,
            t0: e.t0 as number,
            t1: e.t1 as number,
            startedBefore: e.startedBefore === 1,
            stillOut: e.stillOut === 1,
            breaksRoute: e.breaksRoute === 1,
            allLost: e.allLost === 1
        });
    }
    return { window: { start: w.start, end: w.end, seconds }, events: parsed };
}

/**
 * Outages in progress at `windowSecond` (seconds from the window start), by station.
 * A station with several broken lifts keeps the worst case.
 */
export function activeOutagesAt(events: LiftEvent[], windowSecond: number) {
    const active = new Map<string, { breaksRoute: boolean; allLost: boolean }>();
    for (const e of events) {
        // `stillOut` events run to the end of the window, so include their last second.
        const running = windowSecond >= e.t0 && (windowSecond < e.t1 || e.stillOut);
        if (!running) continue;
        const prev = active.get(e.station);
        active.set(e.station, {
            breaksRoute: e.breaksRoute || (prev?.breaksRoute ?? false),
            allLost: e.allLost || (prev?.allLost ?? false)
        });
    }
    return active;
}

function isSecond(value: unknown, max: number): value is number {
    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function isFlag(value: unknown) {
    return value === 0 || value === 1;
}
