// How stations are drawn: camera, dot size and colour. Shared by both renderers in
// `/screen` (deck.gl and the MapLibre fallback) so they always look the same.
import { WebMercatorViewport } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { activeOutagesAt } from './realtime/lift-events';
import type {
    LiftEvent,
    LiftWindow,
    ScreenMapViewState,
    Station,
    StepFree
} from './realtime/types';
import { replayProgress, sceneAt, type SceneId } from './timeline';
import { mapAreaPixelSize, type WallConfig } from './wall';

export type Rgba = [number, number, number, number];

// Dark basemap (CARTO Dark Matter, OpenStreetMap data): credited in zone D.
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Pre-computed drawing values, so renderers do no maths per frame.
export type StationDot = {
    id: string;
    position: [number, number];
    radius: number; // pixels on one physical wall screen
    color: Rgba;
    lineColor: Rgba; // outline; alpha 0 = no outline
};

// What the story needs the map to show right now (see timeline.ts).
export type DotLook = {
    scene: SceneId;
    // Stations with a lift out of service at the current replay moment (empty outside 'replay').
    outages: ReadonlyMap<string, { breaksRoute: boolean; allLost: boolean }>;
};

// Dark-wall palette (no large bright areas). Three hues that read apart from the room:
// teal = step-free to every platform, amber = to some platforms, grey = not step-free.
export const STEP_FREE_COLORS: Record<StepFree, Rgba> = {
    2: [45, 212, 191, 255], // every platform step-free
    1: [251, 191, 36, 235], // some platforms: amber, so it never reads as "nearly teal"
    0: [168, 168, 180, 210] // none: grey, visible but quieter than the colours
};
// Scene 'network': every station the same, before the step-free split is revealed.
const NEUTRAL_COLOR: Rgba = [200, 200, 210, 200];
// Outlines: a lift out of service (matches zone C's red bars), and single-lift stations.
// Otherwise a thin panel-dark ring, which keeps overlapping dots apart (e.g. Tower Hill
// and Tower Gateway sit about 50 px apart on the wall).
const OUTAGE_LINE: Rgba = [239, 83, 80, 240];
const FRAGILE_LINE: Rgba = [255, 255, 255, 170];
const DARK_LINE: Rgba = [9, 9, 11, 220];
// Outline width in screen pixels. Constant, so only colour animates.
const LINE_WIDTH_PX = 5;
// Basemap labels and icons (place names, road shields) are dimmed to this opacity so the
// dots lead; the base style's own value is 1.
const BASEMAP_LABEL_OPACITY = 0.3;
// Colour changes fade over this long instead of snapping (no flashing on the wall).
export const DOT_FADE_MS = 1500;

// Dot radius in screen pixels (one physical 1920 x 1080 screen). Area grows with entries,
// so radius grows with the square root. Sized for the room, not a laptop: the busiest hub is
// about a tenth of a screen tall, the quietest station still a clear dot (BEST_PRACTICES §6).
const RADIUS_MIN_PX = 14;
const RADIUS_MAX_PX = 70;
// Those sizes are for the DO's map area, 4 screens = 4320 px tall. The camera fits the same
// `MAP_FOCUS` box into whatever map area a wall has, so a map half as tall is zoomed out by
// half; `dotScale` shrinks the dots by the same ratio, keeping their share of the map (and
// their overlaps) identical on the 3 x 2 simulator, the preview and the real wall.
const REFERENCE_MAP_HEIGHT_PX = 4 * 1080;

// What the camera frames: inner London, not every last station.
// The map area is very wide (8 screens by 4, about 3.6:1) while the network is about 1.6:1,
// so the north-south extent sets the zoom. Fitting every station (Epping to Morden) put the
// whole network in the middle 45% of the map, with empty countryside either side. This box
// zooms in about 1.4x: the network fills the width, and the far north and south ends
// (High Barnet, Cockfosters, Epping, Morden, the Wimbledon branch) fall off the top and
// bottom edges. They still count in every number on the wall; zone D says so.
export const MAP_FOCUS = {
    west: -0.45,
    south: 51.46,
    east: 0.2,
    north: 51.6
} as const;

export function stationRadius(entries: number, maxEntries: number) {
    if (maxEntries <= 0) return RADIUS_MIN_PX;
    return RADIUS_MIN_PX + (RADIUS_MAX_PX - RADIUS_MIN_PX) * Math.sqrt(entries / maxEntries);
}

/** Fill colour for one station in the current scene. */
function dotColor(s: Station, look: DotLook): Rgba {
    if (look.scene === 'network') return NEUTRAL_COLOR;
    const outage = look.outages.get(s.id);
    // A broken lift that was the only step-free route: the station loses its teal.
    if (outage?.allLost) return STEP_FREE_COLORS[0];
    if (outage?.breaksRoute && s.stepFree === 2) return STEP_FREE_COLORS[1];
    return STEP_FREE_COLORS[s.stepFree];
}

function dotLine(s: Station, look: DotLook): Rgba {
    if (look.scene === 'replay' && look.outages.has(s.id)) return OUTAGE_LINE;
    if (look.scene === 'fragile' && s.oneLift) return FRAGILE_LINE;
    return DARK_LINE;
}

export function buildStationDots(stations: Station[], look: DotLook): StationDot[] {
    const maxEntries = stations.reduce((max, s) => Math.max(max, s.entries), 0);
    return (
        stations
            .map((s) => ({
                id: s.id,
                position: [s.lon, s.lat] as [number, number],
                radius: stationRadius(s.entries, maxEntries),
                color: dotColor(s, look),
                lineColor: dotLine(s, look)
            }))
            // Big dots first so small ones are drawn on top and stay visible.
            // Same input order every time, so each station keeps its index and
            // deck.gl can fade its colour from the old value to the new one.
            .sort((a, b) => b.radius - a.radius)
    );
}

/** Dot size multiplier for a wall: 1 on the DO, 0.5 on the 3 x 2 simulator. */
export function dotScale(wall: WallConfig) {
    return mapAreaPixelSize(wall).height / REFERENCE_MAP_HEIGHT_PX;
}

/**
 * deck.gl layer for the dots. `pixelScale` shrinks them together with the map: `dotScale`
 * of the wall, times the preview's scale when the wall is drawn smaller than life.
 * `minPixels` is a floor on the drawn radius: `/preview` uses it so dots stay visible at
 * 1:18, which slightly exaggerates the smallest ones there (never on the wall).
 */
export function createStationLayer(dots: StationDot[], pixelScale = 1, minPixels = 0) {
    return new ScatterplotLayer<StationDot>({
        id: 'stations',
        data: dots,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        radiusScale: pixelScale,
        radiusMinPixels: minPixels,
        getFillColor: (d) => d.color,
        stroked: true,
        getLineColor: (d) => d.lineColor,
        getLineWidth: LINE_WIDTH_PX,
        lineWidthUnits: 'pixels',
        lineWidthScale: pixelScale,
        // deck.gl animates colour changes with requestAnimationFrame for us.
        transitions: { getFillColor: DOT_FADE_MS, getLineColor: DOT_FADE_MS },
        pickable: false
    });
}

/**
 * Quieten the basemap once its style is in: every symbol layer (place names, road
 * numbers) drops to BASEMAP_LABEL_OPACITY. Roads and water keep the style's own look.
 * Works for both renderers: deck.gl's Map child and the MapLibre fallback.
 */
export function quietenBasemap(map: MapLibreMap) {
    const apply = () => {
        for (const layer of map.getStyle()?.layers ?? []) {
            if (layer.type !== 'symbol') continue;
            map.setPaintProperty(layer.id, 'text-opacity', BASEMAP_LABEL_OPACITY);
            map.setPaintProperty(layer.id, 'icon-opacity', BASEMAP_LABEL_OPACITY);
        }
    };
    if (map.isStyleLoaded()) apply();
    else void map.once('style.load', apply);
}

/**
 * Everything the map needs at loop time `t`: the scene and, during the replay,
 * which stations have a lift out. `t` null (before mount) shows the first scene.
 */
export function lookAt(
    t: number | null,
    liftEvents: LiftEvent[],
    liftWindow: LiftWindow | null
): DotLook {
    const scene = sceneAt(t ?? 0).id;
    if (scene !== 'replay' || !liftWindow) return { scene, outages: new Map() };
    // Map 60 s of replay onto the whole outage window.
    const windowSecond = replayProgress(t ?? 0) * liftWindow.seconds;
    return { scene, outages: activeOutagesAt(liftEvents, windowSecond) };
}

/** Short string that changes only when the map's look changes (used to skip re-renders). */
export function lookKey(look: DotLook) {
    const parts = [...look.outages].map(([id, o]) => `${id}:${+o.breaksRoute}${+o.allLost}`);
    return `${look.scene}|${parts.sort().join(',')}`;
}

/**
 * Move the camera by (dx, dy) wall pixels at the same zoom:
 * 1) project the current centre to pixels, 2) add the offset, 3) unproject to lon/lat.
 * Every tile uses this with its own offset, so the map lines up across screen edges.
 */
export function shiftView(
    baseView: ScreenMapViewState,
    wall: WallConfig,
    offset: { x: number; y: number }
): ScreenMapViewState {
    const viewport = new WebMercatorViewport({
        ...baseView,
        width: wall.screenWidth,
        height: wall.screenHeight
    });
    const [centerX, centerY] = viewport.project([baseView.longitude, baseView.latitude]);
    const [longitude, latitude] = viewport.unproject([centerX + offset.x, centerY + offset.y]);
    return { ...baseView, longitude, latitude };
}

export function rgbaToCss([r, g, b, a]: Rgba) {
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/**
 * The shared camera: frames `MAP_FOCUS` in the wall's map area. Deterministic: every screen
 * computes the same view from the same constants, so no bus message is needed.
 * The returned centre is the centre of the map area (see `tileCenterOffset`).
 * Returns null until stations are loaded, so the map and the dots appear together.
 */
export function fitStationsView(wall: WallConfig, stations: Station[]): ScreenMapViewState | null {
    if (stations.length === 0) return null;
    const { width, height } = mapAreaPixelSize(wall);
    const fitted = new WebMercatorViewport({ width, height }).fitBounds(
        [
            [MAP_FOCUS.west, MAP_FOCUS.south],
            [MAP_FOCUS.east, MAP_FOCUS.north]
        ],
        { padding: 0 }
    );
    return {
        longitude: fitted.longitude,
        latitude: fitted.latitude,
        zoom: fitted.zoom,
        bearing: 0,
        pitch: 0
    };
}
