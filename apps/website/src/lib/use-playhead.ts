import { useEffect, useState } from 'react';

import { screenEngine } from './realtime/engines/screen-engine';
import { LOOP_SECONDS } from './timeline';

// The map only changes at scene boundaries and lift events, so 4 updates a second is plenty.
// Smoothness comes from deck.gl's colour transitions, not from re-rendering every frame.
const PLAYHEAD_STEP_S = 0.25;

/**
 * Seconds into the autoplay loop, rounded down to PLAYHEAD_STEP_S.
 * `null` on the server and on the first client render, so hydration markup matches.
 */
export function usePlayhead(): number | null {
    const [t, setT] = useState<number | null>(null);

    useEffect(() => {
        // Dev aid: `?at=50` freezes the loop at 50 s, to check a scene or take screenshots.
        const at = Number(new URLSearchParams(window.location.search).get('at'));
        if (window.location.search.includes('at=') && Number.isFinite(at) && at >= 0) {
            setT(at % LOOP_SECONDS);
            return;
        }

        let frame = 0;
        const tick = () => {
            const next =
                Math.floor(screenEngine.getLoopSeconds() / PLAYHEAD_STEP_S) * PLAYHEAD_STEP_S;
            // React skips the re-render when the value is unchanged.
            setT(next);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, []);

    return t;
}
