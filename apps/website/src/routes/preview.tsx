import DeckGL from '@deck.gl/react';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { Map } from '@vis.gl/react-maplibre';
import { useEffect, useMemo, useRef, useState } from 'react';

import { WallZonesLayer } from '../components/wall-zones';
import { screenEngine } from '../lib/realtime/engines/screen-engine';
import { useScreenStore } from '../lib/realtime/stores/screen-store';
import {
    createStationLayer,
    dotScale,
    fitStationsView,
    MAP_STYLE,
    quietenBasemap
} from '../lib/station-map';
import { formatClock, LOOP_SECONDS, sceneAt } from '../lib/timeline';
import { usePlayhead } from '../lib/use-playhead';
import { useStoryDots } from '../lib/use-story-dots';
import {
    mapAreaPixelSize,
    wallFromSearch,
    wallPixelSize,
    wallTiles,
    type WallConfig
} from '../lib/wall';

import 'maplibre-gl/dist/maplibre-gl.css';

// `/preview`: the whole wall in ONE canvas, scaled to fit a laptop window.
// 64 `/screen` iframes would need 64 WebGL contexts (browsers allow ~16), so instead we
// draw once with the same camera maths, zoomed out by the preview's scale factor.
// Defaults to the real 16 x 4 wall; `?wall=sim` previews the simulator layout.
// `?cols=4-11` (1-based, inclusive, as in BRIEF.md) shows only those columns, larger:
// handy for checking one zone, since the full wall is ~20x smaller than life on a laptop.

// Smallest drawn dot radius in the preview, in preview pixels.
const PREVIEW_MIN_DOT_PX = 2.5;

export const Route = createFileRoute('/preview')({
    component: PreviewPage
});

function PreviewPage() {
    const { search } = useLocation();
    const searchParams = (search as Record<string, unknown>) ?? {};
    const wall = wallFromSearch(searchParams, 'do');
    const wallSize = wallPixelSize(wall);
    // Shown columns (0-based, inclusive) and their size in wall pixels.
    const [firstCol, lastCol] = colsFromSearch(searchParams.cols, wall);
    const shownSize = {
        width: (lastCol - firstCol + 1) * wall.screenWidth,
        height: wallSize.height
    };

    const stations = useScreenStore((state) => state.stations);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const [isClient, setIsClient] = useState(false);
    // Preview pixels per wall pixel, e.g. 1500 / 30720 ≈ 0.049 for the whole wall on a laptop.
    const [scale, setScale] = useState(0);

    useEffect(() => {
        setIsClient(true);
        void screenEngine.ensureStationsLoaded();
        void screenEngine.ensureLiftEventsLoaded();
        void screenEngine.ensureFindingsLoaded();
    }, []);

    // Fit the shown columns into the available box, by width or by height, whichever binds.
    useEffect(() => {
        const node = frameRef.current;
        if (!node) return;
        const update = () =>
            setScale(
                Math.min(node.clientWidth / shownSize.width, node.clientHeight / shownSize.height)
            );
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, [shownSize.width, shownSize.height]);

    // Same shared camera as every `/screen` (centred on the map area), zoomed out:
    // one zoom level halves the size, so shrinking by `scale` = adding log2(scale) to zoom.
    // The canvas covers exactly the map area, so its centre is the camera's centre.
    const previewView = useMemo(() => {
        const wallView = fitStationsView(wall, stations);
        if (!wallView || scale <= 0) return null;
        return { ...wallView, zoom: wallView.zoom + Math.log2(scale) };
    }, [wall, stations, scale]);
    const [mapFirst] = wall.mapCols;
    const mapSize = mapAreaPixelSize(wall);

    const t = usePlayhead();
    const dots = useStoryDots(t);
    // Dev readout: is the loop clock coming from the bus, or this page's own fallback?
    const busSynced = useScreenStore((state) => state.timeline.startedAt !== null);
    // Dots shrink by the same factor as the map, so the preview shows true proportions,
    // with a small floor so the quietest stations don't vanish at 1:18 (see station-map.ts).
    const stationLayer = useMemo(
        () => createStationLayer(dots, scale * dotScale(wall), PREVIEW_MIN_DOT_PX),
        [dots, scale, wall]
    );

    const shownAll = firstCol === 0 && lastCol === wall.cols - 1;

    return (
        <main className="flex h-screen w-screen flex-col gap-[1.5vh] overflow-hidden bg-zinc-950 px-[2vw] py-[1.5vh] text-zinc-300">
            <header className="flex items-baseline justify-between gap-4 text-[clamp(0.75rem,1.2vw,1rem)]">
                <h1 className="font-semibold text-zinc-100">
                    Wall preview · {wall.cols} x {wall.rows} screens · {wallSize.width} x{' '}
                    {wallSize.height} px
                    {shownAll ? '' : ` · columns ${firstCol + 1}–${lastCol + 1}`}
                    {scale > 0 ? ` · 1:${Math.round(1 / scale)}` : ''}
                </h1>
                <span className="text-zinc-500 tabular-nums">
                    {/* Only after mount (t is null until then): the server has no clock or
                        stations, so this must not differ during hydration. */}
                    {t !== null && stations.length > 0
                        ? `${formatClock(t)} / ${formatClock(LOOP_SECONDS)} · ${sceneAt(t).caption} · ` +
                          `${busSynced ? 'synced to bus' : 'local clock (no bus)'} · ${stations.length} stations`
                        : 'loading…'}
                </span>
            </header>

            {/* Fitting box: the frame inside keeps the shown columns' aspect ratio. */}
            <div ref={frameRef} className="flex min-h-0 flex-1 items-center justify-center">
                <div
                    className="relative overflow-hidden bg-black"
                    style={{ width: shownSize.width * scale, height: shownSize.height * scale }}
                >
                    {/* The map only exists in the map columns (zone B), as on the real wall.
                        It is placed in preview pixels, shifted left by the hidden columns. */}
                    <div
                        className="absolute top-0"
                        style={{
                            left: (mapFirst - firstCol) * wall.screenWidth * scale,
                            width: mapSize.width * scale,
                            height: mapSize.height * scale
                        }}
                    >
                        {isClient && previewView ? (
                            <DeckGL
                                controller={false}
                                viewState={previewView}
                                layers={[stationLayer]}
                                style={{ width: '100%', height: '100%' }}
                            >
                                <Map
                                    reuseMaps
                                    attributionControl={false}
                                    mapStyle={MAP_STYLE}
                                    onLoad={(e) => quietenBasemap(e.target)}
                                />
                            </DeckGL>
                        ) : null}
                    </div>

                    {/* Wall-pixel layer: a 30,720 x 4,320 box scaled down by `scale` and shifted
                        left by the hidden columns. The zone panels and screen borders are placed
                        in it in real wall units. */}
                    <div
                        className="pointer-events-none absolute top-0 left-0 origin-top-left"
                        style={{
                            width: wallSize.width,
                            height: wallSize.height,
                            transform: `translate(${-firstCol * wall.screenWidth * scale}px, 0) scale(${scale})`
                        }}
                    >
                        <WallZonesLayer
                            wall={wall}
                            zones={wall.zones}
                            t={t}
                            tile={{ c: 0, r: 0 }}
                            units="pixels"
                        />
                        {wallTiles(wall).map((tile) => (
                            <div
                                key={tile.id}
                                className="absolute border-solid border-white/15"
                                style={{
                                    left: tile.c * wall.screenWidth,
                                    top: tile.r * wall.screenHeight,
                                    width: wall.screenWidth,
                                    height: wall.screenHeight,
                                    // 1 preview pixel, expressed in wall pixels (before scaling).
                                    borderWidth: scale > 0 ? 1 / scale : 0
                                }}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <p className="text-[clamp(0.7rem,1vw,0.9rem)] text-zinc-500">
                Map area: columns {wall.mapCols[0] + 1}–{wall.mapCols[1] + 1}. Thin lines show each
                physical screen. Zoom in with <code>?cols=1-3</code>, <code>?cols=4-11</code>,{' '}
                <code>?cols=12-14</code> or <code>?cols=15-16</code>; one screen at life size is{' '}
                <code>/screen?wall=do&amp;c=&lt;col&gt;&amp;r=&lt;row&gt;</code> (0-based).
            </p>
        </main>
    );
}

/** `?cols=4-11` or `?cols=7` (1-based, inclusive) -> 0-based [first, last]; else the whole wall. */
function colsFromSearch(value: unknown, wall: WallConfig): [number, number] {
    const all: [number, number] = [0, wall.cols - 1];
    const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(text);
    if (!match) return all;
    const a = Number(match[1]) - 1;
    const b = match[2] === undefined ? a : Number(match[2]) - 1;
    const first = Math.max(0, Math.min(a, b));
    const last = Math.min(wall.cols - 1, Math.max(a, b));
    return first <= last ? [first, last] : all;
}
