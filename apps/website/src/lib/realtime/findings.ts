// Numbers shown on the wall, read from `/data/findings.json` (pipeline/build.py writes it,
// next to the SQL that produced each number). Nothing on the wall is typed in by hand.

const FINDINGS_URL = '/data/findings.json';

export type WallNumbers = {
    stationsTotal: number;
    stationsWithStepFree: number;
    stationsFull: number; // step-free to every platform
    pctNoStepFree: number;
    pctFullStepFree: number; // share of journeys starting at a fully step-free station
    oneLiftStations: number;
    // Insights (findings busiest_no_step_free[0], busiest_step_free[0], replay_impact).
    busiestNoStepFree: { name: string; entries: number; nearest: string; km: number };
    busiestStepFree: { name: string; entries: number };
    replayImpact: {
        routeBrokenHours: number;
        outagesWholeWindow: number;
        longestStation: string;
        longestHours: number;
    };
    replay: {
        outages: number;
        stations: number;
        stationsRouteBroken: number;
        stationsLostAll: number;
    };
    // How much of the lift feed was actually observed (zone D states this as an assumption).
    coverage: {
        firstPoll: string; // ISO, UTC
        lastPoll: string;
        okPolls: number;
        failedPolls: number;
        hoursObserved: number;
        hoursInWindow: number;
    };
    sources: { scope: string; footfallVersion: string; stepFreePublished: string };
};

let findingsRequest: Promise<unknown> | null = null;

export async function loadFindingsDataset(): Promise<unknown> {
    if (typeof window === 'undefined') return null;
    if (!findingsRequest) {
        findingsRequest = (async () => {
            try {
                const response = await fetch(FINDINGS_URL, {
                    headers: { accept: 'application/json' }
                });
                if (!response.ok) return null;
                return (await response.json()) as unknown;
            } catch {
                return null;
            }
        })();
    }
    const payload = await findingsRequest;
    if (payload === null) findingsRequest = null;
    return payload;
}

/** Pick the wall's numbers out of findings.json. Any missing or non-numeric value -> null. */
export function parseFindings(payload: unknown): WallNumbers | null {
    const f = get(payload, 'findings');
    const sources = get(payload, 'sources');
    const n = (key: string, field: string) => num(get(get(get(f, key), 'result'), field));
    const s = (...path: string[]) => {
        let v: unknown = sources;
        for (const p of path) v = get(v, p);
        return typeof v === 'string' ? v : null;
    };

    // First row of a list-valued finding (e.g. the busiest station of a top-10).
    const first = (key: string) => {
        const rows = get(get(f, key), 'result');
        return Array.isArray(rows) ? rows[0] : undefined;
    };
    const busiestNone = first('busiest_no_step_free');
    const busiestFull = first('busiest_step_free');

    const values = {
        stationsTotal: n('station_counts', 'stations_total'),
        stationsWithStepFree: n('station_counts', 'stations_with_step_free'),
        stationsFull: n('station_counts', 'stations_full'),
        pctNoStepFree: n('headline_entries_share', 'pct_no_step_free'),
        pctFullStepFree: n('headline_entries_share', 'pct_full_step_free'),
        oneLiftStations: n('single_lift_dependency', 'stations_all_platforms'),
        busiestNoneName: str(get(busiestNone, 'name')),
        busiestNoneEntries: num(get(busiestNone, 'annual_entries')),
        busiestNoneNearest: str(get(busiestNone, 'nearest_step_free')),
        busiestNoneKm: num(get(busiestNone, 'km')),
        busiestFullName: str(get(busiestFull, 'name')),
        busiestFullEntries: num(get(busiestFull, 'annual_entries')),
        routeBrokenHours: n('replay_impact', 'route_broken_hours'),
        outagesWholeWindow: n('replay_impact', 'outages_whole_window'),
        longestStation: str(get(get(get(f, 'replay_impact'), 'result'), 'longest_station')),
        longestHours: n('replay_impact', 'longest_hours'),
        outages: n('replay', 'outages'),
        stations: n('replay', 'stations'),
        stationsRouteBroken: n('replay', 'stations_route_broken'),
        stationsLostAll: n('replay', 'stations_lost_all_step_free'),
        okPolls: n('lift_window', 'ok_polls'),
        failedPolls: n('lift_window', 'failed_polls'),
        hoursObserved: n('lift_window', 'hours_observed'),
        hoursInWindow: n('lift_window', 'hours_in_window'),
        firstPoll: str(get(get(get(f, 'lift_window'), 'result'), 'first_poll')),
        lastPoll: str(get(get(get(f, 'lift_window'), 'result'), 'last_poll')),
        scope: s('scope'),
        footfallVersion: s('footfall', 'version'),
        stepFreePublished: s('step_free', 'published')
    };
    if (Object.values(values).some((v) => v === null)) return null;
    const v = values as { [K in keyof typeof values]: NonNullable<(typeof values)[K]> };
    return {
        stationsTotal: v.stationsTotal,
        stationsWithStepFree: v.stationsWithStepFree,
        stationsFull: v.stationsFull,
        pctNoStepFree: v.pctNoStepFree,
        pctFullStepFree: v.pctFullStepFree,
        oneLiftStations: v.oneLiftStations,
        busiestNoStepFree: {
            name: v.busiestNoneName,
            entries: v.busiestNoneEntries,
            nearest: v.busiestNoneNearest,
            km: v.busiestNoneKm
        },
        busiestStepFree: { name: v.busiestFullName, entries: v.busiestFullEntries },
        replayImpact: {
            routeBrokenHours: v.routeBrokenHours,
            outagesWholeWindow: v.outagesWholeWindow,
            longestStation: v.longestStation,
            longestHours: v.longestHours
        },
        replay: {
            outages: v.outages,
            stations: v.stations,
            stationsRouteBroken: v.stationsRouteBroken,
            stationsLostAll: v.stationsLostAll
        },
        coverage: {
            firstPoll: v.firstPoll,
            lastPoll: v.lastPoll,
            okPolls: v.okPolls,
            failedPolls: v.failedPolls,
            hoursObserved: v.hoursObserved,
            hoursInWindow: v.hoursInWindow
        },
        sources: {
            scope: v.scope,
            footfallVersion: v.footfallVersion,
            stepFreePublished: v.stepFreePublished
        }
    };
}

function get(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
