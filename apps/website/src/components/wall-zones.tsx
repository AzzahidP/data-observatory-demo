// Zone panels A-D, laid out in WALL coordinates (BRIEF.md section 3).
//
// Units: everything is a multiple of one screen's width/height, given as CSS variables:
//   --sw / --sh = 100vw / 100vh on a real wall screen, 1920px / 1080px inside `/preview`.
// So the same markup is correct on the wall, in the simulator and in the preview.
// Each line of text sits inside one screen row, so no text is cut by a horizontal bezel.
import type { CSSProperties, ReactNode } from 'react';

import type { WallNumbers } from '../lib/realtime/findings';
import { useScreenStore } from '../lib/realtime/stores/screen-store';
import type { LiftEvent, LiftWindow, Station } from '../lib/realtime/types';
import { replayProgress, sceneAt, type SceneId } from '../lib/timeline';
import type { WallConfig, WallZone } from '../lib/wall';

// Text sizes as a share of one screen's height, chosen for reading from the middle of the
// room (BEST_PRACTICES §6: primary text >= 20% of screen height). Everything below `body`
// is reference text: sources and method, meant for someone who walks up to the wall.
const TEXT = {
    hero: 0.6, // the big numbers
    title: 0.42, // the question / zone titles
    headline: 0.2, // the sentence next to a big number
    body: 0.14,
    insight: 0.11, // one-sentence findings under a headline
    small: 0.1, // labels, legend, station names
    reference: 0.075 // sources and method (below the §6 floor by design)
} as const;

const FADE = 'opacity 1.5s ease-in-out';
const TEAL = 'rgb(45, 212, 191)';
const AMBER = 'rgb(251, 191, 36)';
const RED = 'rgb(239, 83, 80)';
const RED_DIM = 'rgba(239, 83, 80, 0.4)';
const GREY = 'rgb(161, 161, 170)';
const LIGHT = 'rgb(212, 212, 216)';
const PANEL = 'rgb(9, 9, 11)';

// Zone C geometry (in screens): the name column, then the bar track to the right edge.
const C_PAD = 0.08;
const C_NAME_W = 1.05;
const C_GAP = 0.05;
const C_TRACK_LEFT = C_PAD + C_NAME_W + C_GAP; // 1.18 screens from the zone's left edge
const C_ROWS_PER_SCREEN = 5; // station rows per screen row (3 screen rows -> 15 stations)

const sh = (k: number) => `calc(var(--sh) * ${k})`;
const sw = (k: number) => `calc(var(--sw) * ${k})`;

type LayerProps = {
    wall: WallConfig;
    zones: readonly WallZone[];
    t: number | null;
    // Which tile this layer is drawn on (0, 0 for `/preview`, which draws the whole wall).
    tile: { c: number; r: number };
    units: 'viewport' | 'pixels';
};

/** Positions the whole wall so that tile (c, r) sits at this element's top-left corner. */
export function WallZonesLayer({ wall, zones, t, tile, units }: LayerProps) {
    const vars = {
        '--sw': units === 'viewport' ? '100vw' : `${wall.screenWidth}px`,
        '--sh': units === 'viewport' ? '100vh' : `${wall.screenHeight}px`
    } as CSSProperties;

    return (
        <div
            className="pointer-events-none absolute"
            style={{
                ...vars,
                left: sw(-tile.c),
                top: sh(-tile.r),
                width: sw(wall.cols),
                height: sh(wall.rows),
                fontFamily: 'Arial, Helvetica, sans-serif'
            }}
        >
            {zones.map((zone) => (
                <ZonePanel key={zone.id} wall={wall} zone={zone} t={t} />
            ))}
        </div>
    );
}

function ZonePanel({ wall, zone, t }: { wall: WallConfig; zone: WallZone; t: number | null }) {
    const numbers = useScreenStore((s) => s.wallNumbers);
    const stations = useScreenStore((s) => s.stations);
    const liftEvents = useScreenStore((s) => s.liftEvents);
    const liftWindow = useScreenStore((s) => s.liftWindow);
    // Nothing data-driven before mount (t is null), so server and client HTML match.
    const ready = t !== null && numbers !== null;
    const scene = sceneAt(t ?? 0).id;
    const width = zone.cols[1] - zone.cols[0] + 1;

    return (
        <section
            className="absolute grid text-zinc-100"
            style={{
                left: sw(zone.cols[0]),
                top: 0,
                width: sw(width),
                height: sh(wall.rows),
                gridTemplateRows: `repeat(${wall.rows}, var(--sh))`,
                // Map zone stays transparent; the others are solid dark panels.
                background: zone.id === 'B' ? 'transparent' : PANEL
            }}
        >
            {ready && zone.id === 'A' ? <ZoneA n={numbers} /> : null}
            {ready && zone.id === 'B' ? <ZoneB n={numbers} scene={scene} /> : null}
            {ready && zone.id === 'C' ? (
                <ZoneC
                    n={numbers}
                    t={t}
                    stations={stations}
                    events={liftEvents}
                    window={liftWindow}
                />
            ) : null}
            {ready && zone.id === 'D' ? (
                <ZoneD n={numbers} scene={scene} window={liftWindow} />
            ) : null}
        </section>
    );
}

/** One screen row of a zone, with side padding (`left`/`right` in screens). */
function Row({
    children,
    left = 0.08,
    right = 0.08,
    align = 'center',
    style
}: {
    children?: ReactNode;
    left?: number;
    right?: number;
    align?: 'start' | 'center' | 'end';
    style?: CSSProperties;
}) {
    return (
        <div
            className="flex min-h-0 flex-col overflow-hidden"
            style={{
                justifyContent:
                    align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center',
                paddingLeft: sw(left),
                paddingRight: sw(right),
                paddingTop: sh(0.07),
                paddingBottom: sh(0.07),
                ...style
            }}
        >
            {children}
        </div>
    );
}

function Text({
    size,
    children,
    color,
    bold,
    style
}: {
    size: number;
    children: ReactNode;
    color?: string;
    bold?: boolean;
    style?: CSSProperties;
}) {
    return (
        <p
            style={{
                fontSize: sh(size),
                lineHeight: 1.15,
                fontWeight: bold ? 700 : 400,
                color,
                margin: 0,
                ...style
            }}
        >
            {children}
        </p>
    );
}

/** 24472543 -> '24.5 million' */
function millions(n: number) {
    return `${(n / 1e6).toFixed(1)} million`;
}

// ---------------------------------------------------------------- A · the question

function ZoneA({ n }: { n: WallNumbers }) {
    // Column 1 meets column 16 behind the viewer: keep the text off the left half-screen.
    const left = 0.6;
    const pctFull = Math.round((100 * n.stationsFull) / n.stationsTotal);
    const closed = n.stationsTotal - n.stationsWithStepFree;
    return (
        <>
            <Row left={left} align="end">
                <Text size={TEXT.small} color={GREY}>
                    London Underground &amp; DLR · zones 1–6
                </Text>
            </Row>
            <Row left={left}>
                <Text size={TEXT.title} bold>
                    Can you get in?
                </Text>
            </Row>
            <Row left={left}>
                <Text size={TEXT.hero} bold color={TEAL}>
                    {n.stationsWithStepFree} of {n.stationsTotal}
                </Text>
            </Row>
            <Row left={left} align="start">
                <Text size={TEXT.body}>stations are step-free from the street to a platform.</Text>
                <Text size={TEXT.insight} color={LIGHT} style={{ marginTop: sh(0.05) }}>
                    Only {n.stationsFull} ({pctFull}%) are step-free to every platform. If you use a
                    wheelchair, push a buggy or can&apos;t manage stairs, the other {closed}{' '}
                    stations are closed to you.
                </Text>
            </Row>
        </>
    );
}

// ---------------------------------------------------------------- B · where the gaps are

function ZoneB({ n, scene }: { n: WallNumbers; scene: SceneId }) {
    const visible = scene !== 'network'; // headline lands with the step-free split at 0:15
    const busiestNone = n.busiestNoStepFree;
    const busiestFull = n.busiestStepFree;
    return (
        <>
            {/* Headline band: the top screen row of the map, centred. The map runs under it,
                dimmed by a gradient, so no station is hidden and the text stays readable. */}
            <Row
                align="center"
                style={{
                    alignItems: 'center',
                    opacity: visible ? 1 : 0,
                    transition: FADE,
                    background:
                        'linear-gradient(to bottom, rgba(9, 9, 11, 0.92) 0%, rgba(9, 9, 11, 0.8) 70%, rgba(9, 9, 11, 0) 100%)'
                }}
            >
                <div className="flex items-baseline" style={{ gap: sw(0.12) }}>
                    <Text size={TEXT.title} bold>
                        {n.pctNoStepFree}%
                    </Text>
                    <Text size={TEXT.headline}>
                        of journeys start at a station you can&apos;t step into
                    </Text>
                </div>
                {/* Two human-scale findings behind the share (findings 2a and its mirror). */}
                <Text
                    size={TEXT.insight}
                    color={LIGHT}
                    style={{ marginTop: sh(0.04), textAlign: 'center' }}
                >
                    {busiestNone.name} is the busiest station you can&apos;t step into:{' '}
                    {millions(busiestNone.entries)} journeys a year start there. The nearest
                    step-free station is {busiestNone.nearest}, {busiestNone.km} km away.
                </Text>
                <Text
                    size={TEXT.insight}
                    color={GREY}
                    style={{ marginTop: sh(0.02), textAlign: 'center' }}
                >
                    For comparison, the busiest fully step-free station, {busiestFull.name}, carries{' '}
                    {millions(busiestFull.entries)} journeys a year.
                </Text>
            </Row>
            <Row />
            <Row />
            <Row />
            {/* Legend: bottom-right corner of zone B (south-east London, where the map is
                nearly empty), on its own dark backdrop. */}
            <div
                className="absolute flex flex-col"
                style={{
                    right: sw(0.1),
                    bottom: sh(0.1),
                    padding: `${sh(0.05)} ${sw(0.05)}`,
                    gap: sh(0.035),
                    background: 'rgba(9, 9, 11, 0.75)',
                    borderRadius: sh(0.03),
                    opacity: visible ? 1 : 0,
                    transition: FADE
                }}
            >
                <LegendItem color={TEAL}>step-free to every platform</LegendItem>
                <LegendItem color={AMBER}>step-free to some platforms</LegendItem>
                <LegendItem color="rgb(168, 168, 180)">no step-free access</LegendItem>
                <LegendItem size>dot size = journeys per year</LegendItem>
                <LegendItem ring={RED} hidden={scene !== 'replay'}>
                    lift out of service
                </LegendItem>
                <LegendItem ring="rgba(255, 255, 255, 0.7)" hidden={scene !== 'fragile'}>
                    relies on one lift
                </LegendItem>
            </div>
        </>
    );
}

function LegendItem({
    color,
    ring,
    size,
    hidden,
    children
}: {
    color?: string;
    ring?: string;
    size?: boolean; // small + big grey dot, for the "size = journeys" line
    hidden?: boolean;
    children: ReactNode;
}) {
    const dot = (k: number, background: string) => (
        <span
            className="inline-block shrink-0 rounded-full"
            style={{
                width: sh(k),
                height: sh(k),
                background,
                boxShadow: ring ? `inset 0 0 0 ${sh(0.016)} ${ring}` : undefined
            }}
        />
    );
    return (
        <div
            className="flex items-center"
            style={{
                gap: sh(0.05),
                height: sh(0.12),
                opacity: hidden ? 0 : 1,
                transition: FADE
            }}
        >
            {size ? (
                <span className="flex items-center" style={{ gap: sh(0.02), width: sh(0.16) }}>
                    {dot(0.04, 'rgb(168, 168, 180)')}
                    {dot(0.1, 'rgb(168, 168, 180)')}
                </span>
            ) : (
                <span className="flex items-center justify-center" style={{ width: sh(0.16) }}>
                    {dot(0.09, color ?? 'transparent')}
                </span>
            )}
            <Text size={TEXT.small}>{children}</Text>
        </div>
    );
}

// ---------------------------------------------------------------- C · does it work?

type StationRow = { id: string; name: string; events: LiftEvent[] };

function ZoneC({
    n,
    t,
    stations,
    events,
    window
}: {
    n: WallNumbers;
    t: number;
    stations: Station[];
    events: LiftEvent[];
    window: LiftWindow | null;
}) {
    const scene = sceneAt(t).id;
    if (!window) return null;

    // How much of the window has been "played" so far: nothing before the replay,
    // growing during it, everything during the closing scene.
    const played = scene === 'replay' ? replayProgress(t) : scene === 'fragile' ? 1 : 0;
    const playedSeconds = played * window.seconds;
    const replaying = scene === 'replay';

    const names = new Map(stations.map((s) => [s.id, s.name]));
    // A week has more stations with outages than fit on the wall: show the ones hit hardest.
    const allRows = groupByStation(events, names);
    const rows = allRows.slice(0, C_ROWS_PER_SCREEN * 3);
    const screenRows = [0, 1, 2].map((i) =>
        rows.slice(i * C_ROWS_PER_SCREEN, (i + 1) * C_ROWS_PER_SCREEN)
    );

    const windowHours = window.seconds / 3600;
    const longest = n.replayImpact;
    const longestText =
        longest.longestHours >= windowHours - 0.2
            ? `${longest.longestStation}'s lift, out all week`
            : `${longest.longestStation}'s lift, out for ${longest.longestHours} hours`;
    const shownText =
        rows.length < allRows.length
            ? ` · the ${rows.length} of ${allRows.length} stations hit hardest`
            : '';

    return (
        <>
            <Row align="start" style={{ paddingTop: sh(0.05), paddingBottom: sh(0.04) }}>
                <Text size={TEXT.title * 0.58} bold>
                    Does it work?
                </Text>
                <Text size={TEXT.insight} color={LIGHT} style={{ marginTop: sh(0.015) }}>
                    One week of lift outages, replayed in 60 s · recorded, not live
                </Text>
                <Text size={TEXT.reference * 1.15} color={GREY} style={{ marginTop: sh(0.01) }}>
                    {formatDateRange(window.start, window.end)} · {n.replay.outages} outages at{' '}
                    {n.replay.stations} stations · {n.replay.stationsLostAll} stations lost all
                    step-free access
                </Text>
                <Text size={TEXT.reference * 1.15} color={LIGHT} style={{ marginTop: sh(0.01) }}>
                    Longest: {longestText}
                    {shownText}
                </Text>
                {/* Axis: what the bars mean (left) and the days of the week (right). */}
                <div className="flex" style={{ gap: sw(C_GAP), marginTop: 'auto' }}>
                    <div
                        className="flex flex-col justify-end"
                        style={{ width: sw(C_NAME_W), gap: sh(0.02) }}
                    >
                        <BarKey color={RED_DIM}>lift out of service</BarKey>
                        <BarKey color={RED}>the only step-free route to a platform</BarKey>
                    </div>
                    <TimeAxis window={window} played={played} replaying={replaying} />
                </div>
            </Row>
            {screenRows.map((group, i) => (
                // One screen row holds up to 5 station rows, so no row crosses a bezel.
                <div
                    key={i}
                    className="relative grid"
                    style={{
                        gridTemplateRows: `repeat(${C_ROWS_PER_SCREEN}, 1fr)`,
                        paddingLeft: sw(C_PAD),
                        paddingRight: sw(C_PAD),
                        paddingTop: sh(0.04),
                        paddingBottom: sh(0.04)
                    }}
                >
                    {group.map((row) => (
                        <OutageRow
                            key={row.id}
                            row={row}
                            seconds={window.seconds}
                            playedSeconds={playedSeconds}
                        />
                    ))}
                    {/* Playhead: the replay's "now", drawn down through the bars. Always
                        solid and always present (at the track's start before the replay, at
                        its end after): it only ever moves, it never fades or blinks. */}
                    <div
                        className="absolute top-0 bottom-0"
                        style={{
                            left: `calc(${sw(C_TRACK_LEFT)} + ${played} * (100% - ${sw(C_TRACK_LEFT + C_PAD)}))`,
                            width: sh(0.005),
                            background: TEAL
                        }}
                    />
                </div>
            ))}
        </>
    );
}

function BarKey({ color, children }: { color: string; children: ReactNode }) {
    return (
        <div className="flex items-center" style={{ gap: sw(0.03) }}>
            <span
                className="inline-block shrink-0"
                style={{ width: sw(0.12), height: sh(0.05), background: color }}
            />
            <Text size={TEXT.reference} color={GREY}>
                {children}
            </Text>
        </div>
    );
}

/** Day ticks (UTC midnights) along the bar track, with the replay clock riding on the playhead. */
function TimeAxis({
    window,
    played,
    replaying
}: {
    window: LiftWindow;
    played: number;
    replaying: boolean;
}) {
    const startSod = secondsOfDay(window.start);
    const startDay = Date.parse(window.start.slice(0, 10) + 'T00:00:00Z');
    // One tick at the start of each day; its label sits under the middle of that day.
    const days = Math.ceil((startSod + window.seconds) / 86400);
    const ticks = Array.from({ length: days }, (_, d) => ({
        d,
        x: (d * 86400 - startSod) / window.seconds,
        mid: ((d + 0.5) * 86400 - startSod) / window.seconds
    })).filter(({ mid }) => mid >= 0 && mid <= 1);
    return (
        <div className="relative flex-1" style={{ height: sh(0.24) }}>
            {/* The clock rides on the playhead and stays inside the track. */}
            <Text
                size={TEXT.small}
                bold
                color={TEAL}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: `${played * 100}%`,
                    // Slide the anchor from the label's left edge to its right edge as the
                    // playhead crosses the track, so the label never leaves the track.
                    transform: `translateX(${-played * 100}%)`,
                    whiteSpace: 'nowrap',
                    opacity: replaying ? 1 : 0,
                    transition: FADE,
                    fontVariantNumeric: 'tabular-nums'
                }}
            >
                {clockInWindow(window, played * window.seconds)}
            </Text>
            <div
                className="absolute right-0 left-0"
                style={{
                    bottom: sh(0.085),
                    height: sh(0.004),
                    background: 'rgba(255, 255, 255, 0.35)'
                }}
            />
            {ticks.map(({ d, x, mid }) => (
                <div key={d}>
                    {x >= 0 ? (
                        <span
                            className="absolute"
                            style={{
                                left: `${x * 100}%`,
                                bottom: sh(0.065),
                                width: sh(0.004),
                                height: sh(0.04),
                                background: 'rgba(255, 255, 255, 0.35)'
                            }}
                        />
                    ) : null}
                    <Text
                        size={TEXT.reference}
                        color={GREY}
                        style={{
                            position: 'absolute',
                            left: `${mid * 100}%`,
                            bottom: 0,
                            transform: 'translateX(-50%)',
                            whiteSpace: 'nowrap'
                        }}
                    >
                        {formatWeekday(startDay + d * 86400_000)}
                    </Text>
                </div>
            ))}
        </div>
    );
}

function OutageRow({
    row,
    seconds,
    playedSeconds
}: {
    row: StationRow;
    seconds: number;
    playedSeconds: number;
}) {
    return (
        <div className="flex items-center" style={{ gap: sw(C_GAP) }}>
            <Text
                size={TEXT.small}
                style={{
                    width: sw(C_NAME_W),
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                }}
            >
                {row.name}
            </Text>
            {/* Track = the whole window; red bars grow as the replay passes each outage. */}
            <div
                className="relative flex-1"
                style={{ height: sh(0.09), background: 'rgba(255, 255, 255, 0.08)' }}
            >
                {row.events.map((e) => {
                    const end = Math.min(e.t1, playedSeconds);
                    if (end <= e.t0) return null;
                    return (
                        <span
                            key={`${e.lift}-${e.t0}`}
                            className="absolute top-0 h-full"
                            style={{
                                left: `${(e.t0 / seconds) * 100}%`,
                                width: `${((end - e.t0) / seconds) * 100}%`,
                                // Bright red: this lift was the only step-free route to a platform.
                                background: e.breaksRoute ? RED : RED_DIM
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}

/**
 * One row per station, hardest hit first: most hours with the only step-free route broken,
 * then most hours with any lift out, then by name.
 */
function groupByStation(events: LiftEvent[], names: Map<string, string>): StationRow[] {
    const hours = (evs: LiftEvent[], onlyBreaking: boolean) =>
        evs.reduce((sum, e) => sum + (!onlyBreaking || e.breaksRoute ? e.t1 - e.t0 : 0), 0);
    const byStation = new Map<string, LiftEvent[]>();
    for (const e of events) {
        if (!names.has(e.station)) continue; // outside the map's scope
        byStation.set(e.station, [...(byStation.get(e.station) ?? []), e]);
    }
    return [...byStation.entries()]
        .map(([id, evs]) => ({ id, name: names.get(id) ?? id, events: evs }))
        .sort(
            (a, b) =>
                hours(b.events, true) - hours(a.events, true) ||
                hours(b.events, false) - hours(a.events, false) ||
                a.name.localeCompare(b.name)
        );
}

// ---------------------------------------------------------------- D · so what

function ZoneD({
    n,
    scene,
    window
}: {
    n: WallNumbers;
    scene: SceneId;
    window: LiftWindow | null;
}) {
    // Column 16 meets column 1 behind the viewer: keep the headline off the right half-screen.
    // Sources and method are reference text, so they may use more of the width.
    const right = 0.6;
    const refRight = 0.2;
    const emphasis = scene === 'fragile';
    const c = n.coverage;
    return (
        <>
            <Row right={right} align="end">
                <Text size={TEXT.small} color={GREY}>
                    So what?
                </Text>
                <Text
                    size={TEXT.hero * 0.85}
                    bold
                    style={{ opacity: emphasis ? 1 : 0.55, transition: FADE, marginTop: sh(0.02) }}
                >
                    {n.oneLiftStations}
                </Text>
            </Row>
            <Row right={right} align="start">
                <Text size={TEXT.body}>step-free stations depend on a single lift.</Text>
                <Text size={TEXT.body} color={LIGHT} style={{ marginTop: sh(0.04) }}>
                    If it breaks, step-free access is gone.
                </Text>
                {window ? (
                    <Text size={TEXT.insight} color={GREY} style={{ marginTop: sh(0.06) }}>
                        During {formatDateRange(window.start, window.end)} that happened at{' '}
                        {n.replay.stationsLostAll} stations.
                    </Text>
                ) : null}
            </Row>
            <Row right={refRight} align="start">
                <Text size={TEXT.reference} bold color={LIGHT}>
                    Sources
                </Text>
                <Text size={TEXT.reference} color={GREY} style={{ marginTop: sh(0.02) }}>
                    TfL annual station entry &amp; exit counts, typical 2025 (
                    {n.sources.footfallVersion.replace('version_', '')}). TfL detailed station data,{' '}
                    {formatMonth(n.sources.stepFreePublished)}: step-free routes and lifts. TfL lift
                    disruptions feed (Unified API), polled every 5 min,{' '}
                    {formatDateRange(c.firstPoll, c.lastPoll)}. Scope: {n.sources.scope}. Map ©
                    OpenStreetMap contributors © CARTO.
                </Text>
                <Text size={TEXT.reference} bold style={{ marginTop: sh(0.04) }}>
                    Powered by TfL Open Data
                </Text>
            </Row>
            <Row right={refRight} align="start">
                <Text size={TEXT.reference} bold color={LIGHT}>
                    Method &amp; assumptions
                </Text>
                <Text size={TEXT.reference} color={GREY} style={{ marginTop: sh(0.02) }}>
                    Not live: the wall replays recorded data. Journeys = station entries. Step-free
                    = street to platform by lift, ramp or level path; a station step-free to some
                    platforms counts as step-free, so {n.pctNoStepFree}% is a lower bound.{' '}
                    {c.failedPolls === 0 && c.hoursObserved >= c.hoursInWindow - 0.5 ? (
                        <>
                            The lift feed was polled without a gap for {Math.round(c.hoursInWindow)}{' '}
                            hours ({c.okPolls} polls); outages shorter than 5 min can be missed.
                        </>
                    ) : (
                        <>
                            The lift feed is incomplete: observed for {Math.round(c.hoursObserved)}{' '}
                            of {Math.round(c.hoursInWindow)} hours ({c.failedPolls} of{' '}
                            {c.okPolls + c.failedPolls} polls failed), so outages outside those
                            hours are missing; the replay is the longest gap-free stretch.
                        </>
                    )}{' '}
                    Whether a broken lift cuts a step-free route comes from TfL&apos;s station route
                    data, not from the feed. The map frames inner London; stations off its edges are
                    still counted.
                </Text>
            </Row>
        </>
    );
}

// ---------------------------------------------------------------- date helpers
// Formatted from the ISO strings by hand (no locale APIs), so every screen shows the same text.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** UTC midnight in ms -> 'Wed 11 Nov' */
function formatWeekday(ms: number) {
    const date = new Date(ms);
    return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** '2026-10-20T13:56+00:00' -> 'Oct 2026' */
function formatMonth(iso: string) {
    const [y, m] = iso.slice(0, 7).split('-').map(Number);
    return Number.isFinite(m) ? `${MONTHS[m - 1]} ${y}` : iso;
}

/** '2026-11-03T…' + '2026-11-10T…' -> '3–10 Nov 2026' (or '28 Oct – 3 Nov 2026' across months). */
function formatDateRange(fromIso: string, toIso: string) {
    const [y1, m1, d1] = fromIso.slice(0, 10).split('-').map(Number);
    const [y2, m2, d2] = toIso.slice(0, 10).split('-').map(Number);
    if (![y1, m1, d1, y2, m2, d2].every(Number.isFinite)) return `${fromIso} – ${toIso}`;
    if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
    if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
    return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

/** Seconds since midnight (UTC) of an ISO timestamp like '2026-11-11T00:01:03Z'. */
function secondsOfDay(iso: string) {
    const [h, min, s] = iso.slice(11, 19).split(':').map(Number);
    return h * 3600 + min * 60 + s;
}

/** Day and clock time ('Thu 12 Nov 14:05 UTC') reached `seconds` into the window. */
function clockInWindow(w: LiftWindow, seconds: number) {
    const startDay = Date.parse(w.start.slice(0, 10) + 'T00:00:00Z');
    const total = Math.floor(secondsOfDay(w.start) + seconds);
    const day = Math.floor(total / 86400);
    const sod = total % 86400;
    const hh = String(Math.floor(sod / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sod % 3600) / 60)).padStart(2, '0');
    return `${formatWeekday(startDay + day * 86400_000)} ${hh}:${mm} UTC`;
}
