import { useMemo, useState } from 'react';

import { useScreenStore } from './realtime/stores/screen-store';
import { buildStationDots, lookAt, lookKey, type DotLook } from './station-map';

/**
 * Station dots for loop time `t`. Used by `/screen` and `/preview` so both show the same thing.
 *
 * The playhead moves 4 times a second, but the map's look only changes at scene boundaries
 * and when a lift fails or is fixed. We keep the previous look while its key is unchanged,
 * so the dots (and deck.gl's colour fades) are only rebuilt when something visible changes.
 */
export function useStoryDots(t: number | null) {
    const stations = useScreenStore((s) => s.stations);
    const liftEvents = useScreenStore((s) => s.liftEvents);
    const liftWindow = useScreenStore((s) => s.liftWindow);

    const next = lookAt(t, liftEvents, liftWindow);
    const [look, setLook] = useState<DotLook>(next);
    // React's "adjust state while rendering" pattern: swap in the new look only when it differs.
    if (lookKey(look) !== lookKey(next)) {
        setLook(next);
    }

    return useMemo(() => buildStationDots(stations, look), [stations, look]);
}
