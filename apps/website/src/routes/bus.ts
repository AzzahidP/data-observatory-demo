import { createFileRoute } from '@tanstack/react-router';
import { defineHooks } from 'crossws';

import type {
    BusMessage,
    BusSharedState,
    ControlTimelineMessage,
    ScreenMapViewMessage,
    ScreenSegmentSelectionMessage,
    ScreenTimelineMessage
} from '../lib/realtime';
import { isMapCity } from '../lib/realtime/map-cities';
import { LOOP_SECONDS, playheadSeconds } from '../lib/timeline';

// In-memory bus state for this server process.
// New clients receive this snapshot in the `hello` handshake so they can
// join late without waiting for another control interaction.
const busSharedState: BusSharedState = {
    city: 'london',
    zoom: 9,
    selectedSegmentIndexes: [],
    // The bus owns the autoplay playhead: the loop is counted from when this server started,
    // until `/control` plays, pauses or jumps it (see applyTimelineAction).
    // (Server-side only, so Date.now() here cannot cause a hydration mismatch.)
    timeline: { startedAt: Date.now(), pausedAt: null }
};

const hooks = defineHooks({
    open(peer) {
        // `hello` is our bootstrap packet:
        // it communicates peer identity + current collaborative state.
        peer.send({
            type: 'hello',
            peerId: peer.id,
            state: busSharedState,
            // Lets each client measure how far its clock is from ours.
            serverNow: Date.now()
        });

        // All collaborating clients publish/subscribe on one logical channel (`do`).
        // This keeps the demo simple while still showing fan-out semantics.
        peer.subscribe('do');
        peer.publish('do', {
            type: 'peer',
            peerId: peer.id,
            peerCount: peer.peers.size
        });
    },
    message(peer, message) {
        // Ignore malformed payloads; only valid JSON objects enter the shared-state path.
        let payload: Partial<BusMessage>;
        try {
            const parsed = message.json() as unknown;
            if (typeof parsed !== 'object' || parsed === null) return;
            payload = parsed as Partial<BusMessage>;
        } catch {
            return;
        }
        if (payload.type === 'control/timeline') {
            // The playhead is server state: apply the action here, then tell EVERY client
            // (sender included) the new timeline. No peerId, so nobody filters it as an echo.
            if (!applyTimelineAction(payload as Partial<ControlTimelineMessage>)) return;
            const update: ScreenTimelineMessage = {
                type: 'screen/timeline',
                timeline: { ...busSharedState.timeline },
                serverNow: Date.now()
            };
            peer.send(update);
            peer.publish('do', update);
            return;
        }

        updateBusSharedState(payload);

        // Broadcast to all peers. Each client engine can ignore own echoes via peerId.
        peer.publish('do', {
            ...payload,
            peerId: peer.id,
            peerCount: peer.peers.size
        });
    },
    close(peer) {
        peer.publish('do', {
            type: 'bye',
            peerId: peer.id,
            peerCount: peer.peers.size
        });
        peer.unsubscribe('do');
    }
});

/** Play / pause / jump / restart the shared playhead. Returns false for a malformed message. */
function applyTimelineAction(message: Partial<ControlTimelineMessage>): boolean {
    const now = Date.now();
    const tl = busSharedState.timeline;
    switch (message.action) {
        case 'pause':
            if (tl.pausedAt === null) tl.pausedAt = now;
            return true;
        case 'play':
            // Resume where we paused: shift the start forward by the time spent paused.
            if (tl.pausedAt !== null) {
                tl.startedAt += now - tl.pausedAt;
                tl.pausedAt = null;
            }
            return true;
        case 'restart':
            return applyTimelineAction({ action: 'jump', t: 0 });
        case 'jump': {
            const t = message.t;
            if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t >= LOOP_SECONDS) {
                return false;
            }
            // Start time such that "now" is `t` seconds into the loop; stay paused if paused.
            tl.startedAt = now - t * 1000;
            if (tl.pausedAt !== null) tl.pausedAt = now;
            // Sanity: the result must read back as t (guards against future maths changes).
            return Math.abs(playheadSeconds(now, tl) - t) < 0.01;
        }
        default:
            return false;
    }
}

function updateBusSharedState(payload: Partial<BusMessage>) {
    if (payload.type === 'screen/map-view') {
        const message = payload as Partial<ScreenMapViewMessage>;
        // Preserve last known valid city/zoom for hello-state replay.
        if (isMapCity(message.city)) {
            busSharedState.city = message.city;
        }

        if (typeof message.view?.zoom === 'number') {
            busSharedState.zoom = message.view.zoom;
        }
        return;
    }

    if (payload.type === 'screen/segment-selection') {
        const message = payload as Partial<ScreenSegmentSelectionMessage>;
        if (!Array.isArray(message.indexes)) return;

        // Keep indexes deterministic for easier equality checks in clients and debugging.
        busSharedState.selectedSegmentIndexes = message.indexes
            .filter((value): value is number => Number.isInteger(value) && value >= 0)
            .slice()
            .sort((a, b) => a - b);
    }
}

export const Route = createFileRoute('/bus')({
    server: {
        handlers: {
            GET: async () => {
                // HTTP fallback response: this endpoint is a websocket upgrade target.
                return Object.assign(
                    new Response('WebSocket upgrade is required.', {
                        status: 426
                    }),
                    {
                        crossws: hooks
                    }
                );
            }
        }
    }
});
