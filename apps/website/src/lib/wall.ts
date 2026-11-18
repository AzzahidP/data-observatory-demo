// Wall geometry shared by the simulator (`/`), each wall tile (`/screen`) and `/preview`.
// Pixel sizes are allowed here: they feed camera maths, not layout (BEST_PRACTICES §6).

export type WallId = 'sim' | 'do';

export type WallConfig = {
    id: WallId;
    cols: number;
    rows: number;
    // Native resolution of one physical screen.
    screenWidth: number;
    screenHeight: number;
    // Columns (0-based, inclusive) that show the map. Screens outside it don't load a map.
    mapCols: readonly [first: number, last: number];
    // Story panels (see BRIEF.md section 3). Empty on the simulator: it only shows the map.
    zones: readonly WallZone[];
};

export type ZoneId = 'A' | 'B' | 'C' | 'D';
export type WallZone = { id: ZoneId; cols: readonly [first: number, last: number] };

export const WALLS: Record<WallId, WallConfig> = {
    // Dev simulator: 3 x 2 iframes on the `/` page. The map uses the whole wall.
    sim: {
        id: 'sim',
        cols: 3,
        rows: 2,
        screenWidth: 1920,
        screenHeight: 1080,
        mapCols: [0, 2],
        zones: []
    },
    // Imperial DSI Data Observatory: 16 columns x 4 rows = 30,720 x 4,320 px.
    // Columns below are 0-based (BRIEF.md uses 1-based: A 1-3, B 4-11, C 12-14, D 15-16).
    do: {
        id: 'do',
        cols: 16,
        rows: 4,
        screenWidth: 1920,
        screenHeight: 1080,
        mapCols: [3, 10],
        zones: [
            { id: 'A', cols: [0, 2] }, // the question
            { id: 'B', cols: [3, 10] }, // where the gaps are (the map)
            { id: 'C', cols: [11, 13] }, // does it work? (lift outages)
            { id: 'D', cols: [14, 15] } // so what (single-lift stations, sources)
        ]
    }
};

export function hasMapAt(wall: WallConfig, c: number) {
    return c >= wall.mapCols[0] && c <= wall.mapCols[1];
}

export function zonesAt(wall: WallConfig, c: number) {
    return wall.zones.filter((z) => c >= z.cols[0] && c <= z.cols[1]);
}

export const DEFAULT_WALL: WallId = 'sim';

export function isWallId(value: unknown): value is WallId {
    return value === 'sim' || value === 'do';
}

/** Read `?wall=sim|do` from route search params; anything else falls back to `fallback`. */
export function wallFromSearch(
    search: Record<string, unknown>,
    fallback: WallId = DEFAULT_WALL
): WallConfig {
    return WALLS[isWallId(search.wall) ? search.wall : fallback];
}

export function wallPixelSize(wall: WallConfig) {
    return { width: wall.cols * wall.screenWidth, height: wall.rows * wall.screenHeight };
}

/** Pixel size of the map area (all rows, `mapCols` columns). */
export function mapAreaPixelSize(wall: WallConfig) {
    const [first, last] = wall.mapCols;
    return { width: (last - first + 1) * wall.screenWidth, height: wall.rows * wall.screenHeight };
}

/**
 * Pixel offset of tile (c, r)'s centre from the centre of the map area.
 * The shared camera looks at the map area's centre; each tile shifts by this much.
 * Example on the 3 x 2 sim (map = whole wall): tile (0, 0) -> (-1920, -540).
 */
export function tileCenterOffset(wall: WallConfig, c: number, r: number) {
    const [first, last] = wall.mapCols;
    const mapCenterCol = (first + last + 1) / 2; // in columns from the wall's left edge
    return {
        x: (c + 0.5 - mapCenterCol) * wall.screenWidth,
        y: (r + 0.5 - wall.rows / 2) * wall.screenHeight
    };
}

/** Pixel offset of the whole wall's centre from the map area's centre (used by `/preview`). */
export function wallCenterOffset(wall: WallConfig) {
    const [first, last] = wall.mapCols;
    return { x: (wall.cols / 2 - (first + last + 1) / 2) * wall.screenWidth, y: 0 };
}

/** Every tile of the wall, row by row (matches `/screen?c=<col>&r=<row>`). */
export function wallTiles(wall: WallConfig) {
    return Array.from({ length: wall.cols * wall.rows }, (_, index) => {
        const c = index % wall.cols;
        const r = Math.floor(index / wall.cols);
        return { c, r, id: `${r}-${c}` };
    });
}
