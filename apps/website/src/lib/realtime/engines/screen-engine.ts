import { loopSeconds, parseTimeline, playheadSeconds } from '../../timeline';
import { loadArcSegmentsDataset } from '../arc-segments';
import { loadFindingsDataset, parseFindings } from '../findings';
import { loadLiftEventsDataset, parseLiftEvents } from '../lift-events';
import { getCityMapView, isMapCity } from '../map-cities';
import { loadStationsDataset, parseStations } from '../stations';
import { screenStore } from '../stores/screen-store';
import type {
    ArcSegment,
    BusMessage,
    HelloBusMessage,
    ScreenMapViewMessage,
    ScreenMapViewState,
    ScreenSegmentSelectionMessage,
    ScreenStoreState,
    ScreenTimelineMessage
} from '../types';
import { BusEngine } from './bus-engine';

export class ScreenEngine extends BusEngine<ScreenStoreState> {
    // Guards repeated fetches during retries/rerenders.
    private hasAttemptedArcSegmentLoad = false;
    // Fallback playhead: when this page started (browser clock). Used until the bus says hello,
    // or forever if no bus is reachable, so a screen without a server still plays the loop.
    private readonly localStartedAt: number = typeof window === 'undefined' ? 0 : Date.now();

    private constructor() {
        super('screen', screenStore);
        // Prime datasets early so first render after route mount has data asap.
        void this.ensureStationsLoaded();
        void this.ensureLiftEventsLoaded();
        void this.ensureFindingsLoaded();
    }

    private findingsLoading = false;

    async ensureFindingsLoaded() {
        if (typeof window === 'undefined') return;
        if (this.findingsLoading || this.store.state.wallNumbers) return;
        this.findingsLoading = true;
        const wallNumbers = parseFindings(await loadFindingsDataset());
        this.findingsLoading = false;
        // null (missing/invalid file) leaves panels showing placeholders; a later call retries.
        if (wallNumbers) this.store.setState((prev) => ({ ...prev, wallNumbers }));
    }

    /**
     * Seconds into the autoplay loop right now. Browser-only (uses the clock), so call it
     * after mount, never during server rendering.
     */
    getLoopSeconds() {
        const { startedAt, pausedAt, clockOffsetMs } = this.store.state.timeline;
        if (startedAt === null) return loopSeconds(Date.now(), this.localStartedAt);
        // Convert our clock to the server's clock before comparing with the server's start time.
        return playheadSeconds(Date.now() + clockOffsetMs, { startedAt, pausedAt });
    }

    async ensureLiftEventsLoaded() {
        if (typeof window === 'undefined') return;
        const status = this.store.state.liftEventsStatus;
        if (status === 'loading' || status === 'ready') return;

        this.store.setState((prev) => ({ ...prev, liftEventsStatus: 'loading' }));
        const parsed = parseLiftEvents(await loadLiftEventsDataset());
        this.store.setState((prev) => ({
            ...prev,
            liftWindow: parsed?.window ?? null,
            liftEvents: parsed?.events ?? [],
            liftEventsStatus: parsed ? 'ready' : 'error'
        }));
    }

    static getInstance() {
        const globalWithScreenEngine = globalThis as typeof globalThis & {
            __screenEngineInstance?: ScreenEngine;
        };

        if (!globalWithScreenEngine.__screenEngineInstance) {
            globalWithScreenEngine.__screenEngineInstance = new ScreenEngine();
        }

        return globalWithScreenEngine.__screenEngineInstance;
    }

    setMapView(view: Partial<ScreenMapViewState>) {
        // Merge patch updates so callers can provide only changed camera fields.
        this.store.setState((prev) => ({
            ...prev,
            mapView: {
                ...prev.mapView,
                ...view
            }
        }));
    }

    async ensureStationsLoaded() {
        if (typeof window === 'undefined') return;
        const status = this.store.state.stationsStatus;
        if (status === 'loading' || status === 'ready') return;

        this.store.setState((prev) => ({ ...prev, stationsStatus: 'loading' }));
        const stations = parseStations(await loadStationsDataset());
        // An empty result means the file was missing or every row failed validation.
        // 'error' lets a later call (remount / reconnect) try again.
        this.store.setState((prev) => ({
            ...prev,
            stations,
            stationsStatus: stations.length > 0 ? 'ready' : 'error'
        }));
    }

    async ensureArcSegmentsLoaded() {
        if (typeof window === 'undefined') return;
        if (this.hasAttemptedArcSegmentLoad || this.store.state.arcSegments.length > 0) return;

        this.hasAttemptedArcSegmentLoad = true;
        this.store.setState((prev) => ({
            ...prev,
            isArcSegmentsLoading: true
        }));

        try {
            const payload = await loadArcSegmentsDataset();
            if (!payload) {
                throw new Error('Failed to load arc segments');
            }
            const arcSegments = this.parseArcSegments(payload);

            this.store.setState((prev) => ({
                ...prev,
                arcSegments,
                isArcSegmentsLoading: false
            }));
        } catch {
            // Reset guard so a later user action / reconnect can retry loading data.
            this.hasAttemptedArcSegmentLoad = false;
            this.store.setState((prev) => ({
                ...prev,
                isArcSegmentsLoading: false
            }));
        }
    }

    protected override onMessage(message: BusMessage) {
        if (message.type === 'screen/timeline') {
            const timelineMessage = message as ScreenTimelineMessage;
            this.applyTimeline(timelineMessage.timeline, timelineMessage.serverNow);
            return;
        }

        if (message.type === 'screen/map-view') {
            const mapViewMessage = message as ScreenMapViewMessage;
            this.applyMapViewMessage(mapViewMessage);
            return;
        }

        if (message.type === 'screen/segment-selection') {
            const segmentSelectionMessage = message as ScreenSegmentSelectionMessage;
            this.applySegmentSelection(segmentSelectionMessage.indexes);
        }
    }

    protected override onHello(hello: HelloBusMessage) {
        if (!hello.state) return;
        // Apply the same message handlers used for live events so hello-state and realtime updates
        // follow one code path and stay behaviorally consistent.
        this.applyMapViewMessage({
            type: 'screen/map-view',
            city: hello.state.city,
            view: { zoom: hello.state.zoom }
        });
        this.applySegmentSelection(hello.state.selectedSegmentIndexes);
        this.applyTimeline(hello.state.timeline, hello.serverNow);
    }

    private applyTimeline(timeline: unknown, serverNow: unknown) {
        // Untrusted payload: only accept finite numbers.
        const parsed = parseTimeline(timeline);
        if (!parsed) return;
        if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return;
        // Ignores network delay (a few ms on a LAN), far below what a 2-minute loop can show.
        const clockOffsetMs = serverNow - Date.now();
        this.store.setState((prev) => ({ ...prev, timeline: { ...parsed, clockOffsetMs } }));
    }

    private applyMapViewMessage(mapViewMessage: ScreenMapViewMessage) {
        // Start from current state and layer updates in deterministic order:
        // city preset first, then granular overrides from `view`.
        let nextView = this.store.state.mapView;

        if (isMapCity(mapViewMessage.city)) {
            nextView = {
                ...nextView,
                ...getCityMapView(mapViewMessage.city)
            };
        }

        if (mapViewMessage.view && typeof mapViewMessage.view === 'object') {
            const view = mapViewMessage.view;
            nextView = {
                ...nextView,
                longitude: typeof view.longitude === 'number' ? view.longitude : nextView.longitude,
                latitude: typeof view.latitude === 'number' ? view.latitude : nextView.latitude,
                zoom: typeof view.zoom === 'number' ? view.zoom : nextView.zoom,
                bearing: typeof view.bearing === 'number' ? view.bearing : nextView.bearing,
                pitch: typeof view.pitch === 'number' ? view.pitch : nextView.pitch
            };
        }

        this.setMapView(nextView);
    }

    private applySegmentSelection(indexes: unknown) {
        if (!Array.isArray(indexes)) return;

        const sanitizedIndexes = indexes
            .filter((value): value is number => Number.isInteger(value) && value >= 0)
            .slice()
            .sort((a, b) => a - b);

        this.store.setState((prev) => {
            if (arraysEqual(prev.selectedSegmentIndexes, sanitizedIndexes)) return prev;
            return {
                ...prev,
                selectedSegmentIndexes: sanitizedIndexes
            };
        });
    }

    private parseArcSegments(payload: unknown): ArcSegment[] {
        // Runtime validation keeps map rendering resilient against malformed datasets.
        if (!Array.isArray(payload)) return [];

        const segments: ArcSegment[] = [];
        for (const item of payload) {
            if (typeof item !== 'object' || item === null) continue;
            const candidate = item as Partial<ArcSegment>;
            if (
                typeof candidate.id !== 'string' ||
                !Array.isArray(candidate.start) ||
                !Array.isArray(candidate.end) ||
                candidate.start.length !== 2 ||
                candidate.end.length !== 2 ||
                typeof candidate.start[0] !== 'number' ||
                typeof candidate.start[1] !== 'number' ||
                typeof candidate.end[0] !== 'number' ||
                typeof candidate.end[1] !== 'number' ||
                typeof candidate.weight !== 'number'
            ) {
                continue;
            }

            segments.push({
                id: candidate.id,
                // Copy values into fresh tuples to avoid retaining untrusted references.
                start: [candidate.start[0], candidate.start[1]],
                end: [candidate.end[0], candidate.end[1]],
                weight: candidate.weight
            });
        }

        return segments;
    }
}

export const screenEngine = ScreenEngine.getInstance();

function arraysEqual(a: number[], b: number[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
