import type { WallNumbers } from './findings';

export type BusMessage = {
    // Keep message kinds namespaced (`control/*`, `screen/*`).
    type: string;
    peerId?: string;
    peerCount?: number;
    [key: string]: unknown;
};

export type HelloBusMessage = BusMessage & {
    type: 'hello';
    peerId: string;
    state?: BusSharedState;
    // Server clock (ms since 1970) when hello was sent; lets clients line up with `timeline.startedAt`.
    serverNow?: number;
};

export type ControlSliderMessage = BusMessage & {
    type: 'control/slider';
    value: number;
};

export type ScreenSegmentSelectionMessage = BusMessage & {
    type: 'screen/segment-selection';
    indexes: number[];
};

export type MapCity = 'london' | 'paris' | 'berlin' | 'madrid' | 'rome' | 'amsterdam';

// The autoplay loop's playhead, in the bus server's clock (ms since 1970).
// startedAt: when the current loop run began. pausedAt: when it was paused, or null while
// playing; while paused, every screen shows the moment `pausedAt - startedAt`.
export type BusTimeline = { startedAt: number; pausedAt: number | null };

export type BusSharedState = {
    city: MapCity;
    zoom: number;
    selectedSegmentIndexes: number[];
    // Screens compute "seconds into the loop" from this, so all of them show the same scene.
    timeline: BusTimeline;
};

// `/control` -> bus: change the playhead. `t` (seconds into the loop) only for 'jump'.
export type ControlTimelineMessage = BusMessage & {
    type: 'control/timeline';
    action: 'play' | 'pause' | 'jump' | 'restart';
    t?: number;
};

// bus -> everyone: the playhead changed (sent after a control/timeline message).
export type ScreenTimelineMessage = BusMessage & {
    type: 'screen/timeline';
    timeline: BusTimeline;
    serverNow: number;
};

export type ScreenMapViewState = {
    longitude: number;
    latitude: number;
    zoom: number;
    bearing: number;
    pitch: number;
};

export type ScreenMapViewMessage = BusMessage & {
    type: 'screen/map-view';
    view: Partial<ScreenMapViewState>;
    city?: MapCity;
};

export type ArcSegment = {
    id: string;
    start: [number, number];
    end: [number, number];
    weight: number;
};

// 0 = no step-free platform, 1 = some platforms, 2 = every platform (street to platform).
export type StepFree = 0 | 1 | 2;

// One Tube/DLR station from `/data/stations.json` (written by pipeline/build.py).
export type Station = {
    id: string;
    name: string;
    lon: number;
    lat: number;
    entries: number; // annual entries, typical 2025
    stepFree: StepFree;
    lifts: number;
    oneLift: boolean; // one lift failing removes all step-free access
};

// The lift-outage replay window from `/data/lift-events.json`.
export type LiftWindow = { start: string; end: string; seconds: number };

// One lift outage inside the window. t0/t1 = seconds from the window start.
export type LiftEvent = {
    station: string;
    lift: string;
    t0: number;
    t1: number;
    startedBefore: boolean; // already out when the window opened
    stillOut: boolean; // still out when the window closed
    breaksRoute: boolean; // this lift was the only step-free way to some platform
    allLost: boolean; // ... to every platform: the station lost step-free access
};

export type EngineRole = 'screen' | 'control';

export type EngineConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type EngineStoreState = {
    role: EngineRole;
    peerId: string | null;
    connection: EngineConnectionState;
    messageCount: number;
    lastMessageType: string | null;
    lastMessageAt: number | null;
    lastError: string | null;
};

export const createInitialEngineStoreState = (role: EngineRole): EngineStoreState => ({
    role,
    peerId: null,
    connection: 'idle',
    messageCount: 0,
    lastMessageType: null,
    lastMessageAt: null,
    lastError: null
});

export type ControlStoreState = EngineStoreState & {
    sliderValue: number;
    isSliderInteracting: boolean;
    selectedCity: MapCity;
    selectedSegmentIndexes: number[];
    // Mirror of the bus playhead, so the operator can show the current scene. See ScreenStoreState.
    timeline: { startedAt: number | null; pausedAt: number | null; clockOffsetMs: number };
};

export type ScreenStoreState = EngineStoreState & {
    mapView: ScreenMapViewState;
    arcSegments: ArcSegment[];
    selectedSegmentIndexes: number[];
    isArcSegmentsLoading: boolean;
    stations: Station[];
    stationsStatus: 'idle' | 'loading' | 'ready' | 'error';
    liftWindow: LiftWindow | null;
    liftEvents: LiftEvent[];
    liftEventsStatus: 'idle' | 'loading' | 'ready' | 'error';
    // Numbers for the zone panels (from findings.json); null until loaded.
    wallNumbers: WallNumbers | null;
    // startedAt / pausedAt: from the bus (server clock); startedAt null until hello arrives.
    // clockOffsetMs: server clock minus this browser's clock, measured at hello.
    timeline: { startedAt: number | null; pausedAt: number | null; clockOffsetMs: number };
};

export const createInitialControlStoreState = (): ControlStoreState => ({
    ...createInitialEngineStoreState('control'),
    sliderValue: 25,
    isSliderInteracting: false,
    selectedCity: 'london',
    selectedSegmentIndexes: [],
    timeline: { startedAt: null, pausedAt: null, clockOffsetMs: 0 }
});

export const createInitialScreenStoreState = (): ScreenStoreState => ({
    ...createInitialEngineStoreState('screen'),
    mapView: {
        longitude: -0.1749,
        latitude: 51.4988,
        zoom: 9,
        bearing: 0,
        pitch: 0
    },
    arcSegments: [],
    selectedSegmentIndexes: [],
    isArcSegmentsLoading: false,
    stations: [],
    stationsStatus: 'idle',
    liftWindow: null,
    liftEvents: [],
    liftEventsStatus: 'idle',
    wallNumbers: null,
    timeline: { startedAt: null, pausedAt: null, clockOffsetMs: 0 }
});
