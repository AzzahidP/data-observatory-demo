import type { Station, StepFree } from './types';

const STATIONS_URL = '/data/stations.json';

// Rough box around Greater London + the Metropolitan line's far end: anything outside is bad data.
const LON_RANGE = [-1, 0.5] as const;
const LAT_RANGE = [51.2, 51.9] as const;

let stationsRequest: Promise<unknown> | null = null;

/** Fetch `/data/stations.json` once and share the promise. Returns null on failure. */
export async function loadStationsDataset(): Promise<unknown> {
    if (typeof window === 'undefined') return null;

    if (!stationsRequest) {
        stationsRequest = (async () => {
            try {
                const response = await fetch(STATIONS_URL, {
                    headers: { accept: 'application/json' }
                });
                if (!response.ok) return null;
                return (await response.json()) as unknown;
            } catch {
                return null;
            }
        })();
    }

    const payload = await stationsRequest;
    // Failed reads should not poison the cache forever.
    if (payload === null) stationsRequest = null;
    return payload;
}

/**
 * Validate the untrusted file shape `{ version: 1, stations: [...] }`.
 * Bad rows are dropped, not fixed; values are copied so no reference to the raw JSON is kept.
 */
export function parseStations(payload: unknown): Station[] {
    if (typeof payload !== 'object' || payload === null) return [];
    const { version, stations } = payload as { version?: unknown; stations?: unknown };
    if (version !== 1 || !Array.isArray(stations)) return [];

    const result: Station[] = [];
    const seen = new Set<string>();
    for (const item of stations) {
        if (typeof item !== 'object' || item === null) continue;
        const s = item as Record<string, unknown>;
        if (
            typeof s.id !== 'string' ||
            seen.has(s.id) ||
            typeof s.name !== 'string' ||
            !inRange(s.lon, LON_RANGE) ||
            !inRange(s.lat, LAT_RANGE) ||
            !isNonNegativeInt(s.entries) ||
            !isStepFree(s.stepFree) ||
            !isNonNegativeInt(s.lifts) ||
            (s.oneLift !== 0 && s.oneLift !== 1)
        ) {
            continue;
        }
        seen.add(s.id);
        result.push({
            id: s.id,
            name: s.name,
            lon: s.lon,
            lat: s.lat,
            entries: s.entries,
            stepFree: s.stepFree,
            lifts: s.lifts,
            oneLift: s.oneLift === 1
        });
    }
    return result;
}

function inRange(value: unknown, [min, max]: readonly [number, number]): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isNonNegativeInt(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

function isStepFree(value: unknown): value is StepFree {
    return value === 0 || value === 1 || value === 2;
}
