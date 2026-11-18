import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Button } from '../components/button';
import { controlEngine } from '../lib/realtime/engines/control-engine';
import { useControlStore } from '../lib/realtime/stores/control-store';
import { formatClock, LOOP_SECONDS, SCENES, sceneAt } from '../lib/timeline';

type ControlSearch = {
    // Optional label so multiple control clients can be distinguished in the simulator.
    operator: string;
};

export const Route = createFileRoute('/control')({
    validateSearch: (search: Record<string, unknown>): ControlSearch => {
        return {
            // Default operator id keeps the route usable when query params are omitted.
            operator: typeof search.operator === 'string' ? search.operator : 'A'
        };
    },
    component: ControlPage
});

// How often the operator's clock readout refreshes. The wall itself is driven by the bus.
const CLOCK_TICK_MS = 250;

function ControlPage() {
    // `/control` models a handheld/operator endpoint for the autoplay loop:
    // - it sends intent (play, pause, restart, jump to a scene) into the websocket bus
    // - the bus owns the playhead and answers with `screen/timeline`, which every page applies
    // - it does not render the heavy map visuals itself
    // The wall auto-plays without this page; it only exists for rehearsal and Q&A.
    const { operator } = Route.useSearch();
    const connection = useControlStore((state) => state.connection);
    const paused = useControlStore((state) => state.timeline.pausedAt !== null);
    const synced = useControlStore((state) => state.timeline.startedAt !== null);
    const t = useLoopClock();
    const scene = t === null ? null : sceneAt(t);

    return (
        <main className="h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
            <div className="flex h-full w-full flex-col gap-3 p-3">
                <header className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                    <div>
                        <p className="text-[10px] tracking-[0.2em] text-[var(--muted-foreground)] uppercase">
                            Operator
                        </p>
                        <h1 className="text-sm font-semibold">Control Panel {operator}</h1>
                    </div>
                    <span className="rounded-full bg-[var(--primary)] px-2 py-1 text-[10px] font-medium text-[var(--primary-foreground)]">
                        {connection === 'open'
                            ? synced
                                ? 'bus · synced'
                                : 'bus · waiting'
                            : connection}
                    </span>
                </header>

                {/* Readout: where the loop is right now (same clock as every screen). */}
                <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                    <p className="text-[10px] tracking-[0.2em] text-[var(--muted-foreground)] uppercase">
                        Loop {paused ? '· paused' : ''}
                    </p>
                    <p className="text-lg font-semibold tabular-nums">
                        {t === null ? '–:––' : formatClock(t)}{' '}
                        <span className="text-xs font-normal text-[var(--muted-foreground)]">
                            / {formatClock(LOOP_SECONDS)}
                        </span>
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                        {scene ? scene.caption : 'waiting for the bus…'}
                    </p>
                </section>

                <section className="flex gap-2">
                    <Button
                        onClick={() => controlEngine.timelineAction(paused ? 'play' : 'pause')}
                        variant="highlight"
                        className="flex-1"
                    >
                        {paused ? 'Play' : 'Pause'}
                    </Button>
                    <Button
                        onClick={() => controlEngine.timelineAction('restart')}
                        variant="normal"
                        className="flex-1"
                    >
                        Restart
                    </Button>
                </section>

                {/* One button per scene; jumping keeps the paused/playing state. */}
                <section className="grid grid-cols-2 gap-2">
                    {SCENES.map((s) => (
                        <Button
                            key={s.id}
                            onClick={() => controlEngine.timelineAction('jump', s.start)}
                            variant={scene?.id === s.id ? 'highlight' : 'normal'}
                            className="text-left"
                        >
                            <span className="block text-[10px] text-[var(--muted-foreground)] tabular-nums">
                                {formatClock(s.start)}
                            </span>
                            {s.caption}
                        </Button>
                    ))}
                </section>
            </div>
        </main>
    );
}

/** Seconds into the loop, refreshed a few times a second; null until the bus says hello. */
function useLoopClock() {
    const [t, setT] = useState<number | null>(null);
    useEffect(() => {
        const tick = () => setT(controlEngine.getLoopSeconds());
        tick();
        const id = window.setInterval(tick, CLOCK_TICK_MS);
        return () => window.clearInterval(id);
    }, []);
    return t;
}
