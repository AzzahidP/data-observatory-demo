import DeckGL from '@deck.gl/react';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { Map, type MapRef } from '@vis.gl/react-maplibre';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { WallZonesLayer } from '../components/wall-zones';
import { screenEngine } from '../lib/realtime/engines/screen-engine';
import { useScreenStore } from '../lib/realtime/stores/screen-store';
import {
    createStationLayer,
    dotScale,
    fitStationsView,
    MAP_STYLE,
    quietenBasemap,
    rgbaToCss,
    shiftView
} from '../lib/station-map';
import { usePlayhead } from '../lib/use-playhead';
import { useStoryDots } from '../lib/use-story-dots';
import { hasMapAt, tileCenterOffset, wallFromSearch, zonesAt } from '../lib/wall';

import 'maplibre-gl/dist/maplibre-gl.css';

const STATIONS_SOURCE_ID = 'stations-source';
const STATIONS_LAYER_ID = 'stations-layer';

// Each `/screen` instance represents one wall tile (`c`,`r`) and computes its own camera
// from the shared view. We keep a lighter fallback renderer for iframe deployments where
// many WebGL contexts are active at once.

export const Route = createFileRoute('/screen')({
    component: ScreenPage
});

function ScreenPage() {
    const { search } = useLocation();
    // Query params identify which physical panel this route instance represents.
    const searchParams = (search as Record<string, unknown>) ?? {};
    // `?wall=do` for the real 16 x 4 wall; defaults to the 3 x 2 simulator.
    const wall = wallFromSearch(searchParams);
    const screenC = parseScreenCoordinate(searchParams.c, wall.cols, 0);
    const screenR = parseScreenCoordinate(searchParams.r, wall.rows, 0);

    const stations = useScreenStore((state) => state.stations);
    const [isClient, setIsClient] = useState(false);
    const [useDeckWrapper, setUseDeckWrapper] = useState(false);
    const [mapInstance, setMapInstance] = useState<ReturnType<MapRef['getMap']> | null>(null);

    const setMapRef = useCallback((instance: MapRef | null) => {
        const map = instance?.getMap() ?? null;
        if (map) quietenBasemap(map);
        setMapInstance(map);
    }, []);

    useEffect(() => {
        setIsClient(true);
        // Avoid DeckGL context exhaustion in a multi-iframe wall layout.
        // `window.top` path is used when opening a screen directly in its own tab, where one
        // high-level DeckGL canvas is typically safe.
        setUseDeckWrapper(window.self === window.top);
        // Retry loads that failed earlier (e.g. dev server restarted).
        void screenEngine.ensureStationsLoaded();
        void screenEngine.ensureLiftEventsLoaded();
        void screenEngine.ensureFindingsLoaded();
    }, []);

    // Seconds into the autoplay loop (same on every screen); drives what the dots show.
    const t = usePlayhead();
    const dots = useStoryDots(t);

    // Shared camera: fit the whole network into the wall's map area. Then shift it for this tile.
    const wallView = useMemo(() => fitStationsView(wall, stations), [wall, stations]);
    const localScreenMapView = useMemo(
        () =>
            wallView ? shiftView(wallView, wall, tileCenterOffset(wall, screenC, screenR)) : null,
        [wallView, wall, screenC, screenR]
    );

    // Dots keep their share of the map on every wall size (see dotScale).
    const dotsScale = dotScale(wall);
    const stationLayer = useMemo(() => createStationLayer(dots, dotsScale), [dots, dotsScale]);

    // Fallback path: one GeoJSON source + one circle layer, created once and then updated
    // with setData (cheaper than removing and re-adding layers).
    // Note: MapLibre can't fade colours that come from data, so here changes are instant
    // (single changes at scene boundaries, never repeated blinking).
    const dotsGeojson = useMemo(
        () => ({
            type: 'FeatureCollection' as const,
            features: dots.map((d) => ({
                type: 'Feature' as const,
                properties: {
                    id: d.id,
                    radius: d.radius,
                    color: rgbaToCss(d.color),
                    stroke: rgbaToCss(d.lineColor)
                },
                geometry: { type: 'Point' as const, coordinates: d.position }
            }))
        }),
        [dots]
    );

    useEffect(() => {
        if (!isClient || useDeckWrapper || !mapInstance) return;

        const syncStations = () => {
            if (!mapInstance.isStyleLoaded()) return;
            const source = mapInstance.getSource(STATIONS_SOURCE_ID) as
                | { setData: (data: unknown) => void }
                | undefined;
            if (source) {
                source.setData(dotsGeojson);
                return;
            }
            mapInstance.addSource(STATIONS_SOURCE_ID, { type: 'geojson', data: dotsGeojson });
            mapInstance.addLayer({
                id: STATIONS_LAYER_ID,
                type: 'circle',
                source: STATIONS_SOURCE_ID,
                paint: {
                    'circle-radius': ['*', ['get', 'radius'], dotsScale],
                    'circle-color': ['get', 'color'],
                    'circle-stroke-color': ['get', 'stroke'],
                    'circle-stroke-width': 5 * dotsScale
                }
            });
        };

        syncStations();
        mapInstance.on('load', syncStations);
        return () => {
            mapInstance.off('load', syncStations);
        };
    }, [dotsGeojson, dotsScale, isClient, mapInstance, useDeckWrapper]);

    // Only zone B screens draw the map; A, C and D are text panels and never load one.
    const showMap = hasMapAt(wall, screenC);
    const tileZones = zonesAt(wall, screenC);

    return (
        <main className="pointer-events-none h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
            <div className="relative h-full w-full">
                <div className="absolute inset-0 z-200">
                    {showMap && isClient && useDeckWrapper && localScreenMapView ? (
                        <DeckGL
                            controller={false}
                            viewState={localScreenMapView}
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

                    {showMap && isClient && !useDeckWrapper && localScreenMapView ? (
                        // Iframe-safe fallback implementation: direct map rendering + imperative layers.
                        <Map
                            ref={setMapRef}
                            reuseMaps
                            attributionControl={false}
                            mapStyle={MAP_STYLE}
                            longitude={localScreenMapView.longitude}
                            latitude={localScreenMapView.latitude}
                            zoom={localScreenMapView.zoom}
                            bearing={localScreenMapView.bearing}
                            pitch={localScreenMapView.pitch}
                            style={{ width: '100%', height: '100%' }}
                        />
                    ) : null}
                </div>
                {/* Zone panels, positioned in wall coordinates; this tile shows its slice. */}
                <div className="absolute inset-0 z-300 overflow-hidden">
                    <WallZonesLayer
                        wall={wall}
                        zones={tileZones}
                        t={t}
                        tile={{ c: screenC, r: screenR }}
                        units="viewport"
                    />
                </div>
            </div>
        </main>
    );
}

function parseScreenCoordinate(value: unknown, size: number, fallback: number) {
    // SSR and direct route probes may hit `/screen` without `c`/`r`.
    // Fail gracefully by falling back to a deterministic tile.
    if (value === null || value === undefined) {
        return Math.min(size - 1, Math.max(0, fallback));
    }
    const parsed =
        typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isInteger(parsed)) {
        return Math.min(size - 1, Math.max(0, fallback));
    }
    // Clamp keeps out-of-range coordinates inside the supported wall grid.
    return Math.min(size - 1, Math.max(0, parsed));
}
