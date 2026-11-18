# DO App Kit

A starter for creating DO custom applications.

This starter repo is built with Vite+.

## Runtime Context Note (Top-Level vs Iframe)

Data Observatory deployments may render an app either:

- as a top-level document, or
- inside one or more iframes (for multi-screen orchestration/simulation).

This matters for graphics-heavy features: iframe-based deployments can increase pressure on
browser/GPU context limits (especially with WebGL). For that reason, this example includes
runtime-aware rendering decisions and fallback strategies so behavior remains stable in both modes.

## Stack Used In This Example

The example app in `apps/website` focuses on three package groups:

- `@tanstack/react-router`: file-based routing and route-level app structure (`/`, `/control`, `/screen`, `/bus`).
- `@tanstack/pacer`: throttling of high-frequency control events before broadcast (for example slider updates).
- Mapping stack:
  `maplibre-gl`, `@vis.gl/react-maplibre`, `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/react`.
  These are used to render the map, draw animated paths/markers, and support both richer and iframe-safe rendering paths. We strongly recommend the use of Deck.GL with MapLibre as the DO natively supports them.
- `vite-plus` (`vp`): monorepo task runner/repo manager used for project commands (`vp run dev`, `vp run build -r`, etc.).

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run test -r
```

- Build the monorepo:

```bash
vp run build -r
```

- Run the development server:

```bash
vp run dev
```

## Previewing the 16 x 4 wall

The wall is 30,720 x 4,320 px, so a laptop can only show it about 1:18. Start the dev server
(`vp run dev`, port 5780) and open:

| URL                                            | What you see                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `http://localhost:5780/preview`                | The whole 16 x 4 wall in one canvas, 64:9, with screen bezels drawn                                              |
| `http://localhost:5780/preview?cols=1-3`       | Zone A only (columns 1-3), about 1:5                                                                             |
| `http://localhost:5780/preview?cols=4-11`      | Zone B, the map, about 1:9                                                                                       |
| `http://localhost:5780/preview?cols=12-14`     | Zone C, the lift replay                                                                                          |
| `http://localhost:5780/preview?cols=15-16`     | Zone D, closing number, sources and method                                                                       |
| `http://localhost:5780/screen?wall=do&c=7&r=1` | One physical screen at life size (0-based column and row); make the browser window 1920 x 1080 or full-screen it |
| `http://localhost:5780/preview?wall=sim`       | The 3 x 2 dev simulator layout                                                                                   |

Add `&at=<seconds>` to any of these to freeze the loop at that moment, e.g. `?at=20` for the
step-free split, `?at=70` mid-replay, `?at=110` for the single-lift closing scene.
`/control` has play/pause and jump-to-scene buttons that drive every open page over the bus.

The map is framed on inner London (`MAP_FOCUS` in `src/lib/station-map.ts`); the far north
and south ends of the network are off the map's edges but still count in every number.
