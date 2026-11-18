#!/usr/bin/env python3
"""Build the demo's tables from the raw TfL files (run fetch.py first).

Run from this folder:
    .venv/bin/python build.py

Writes out/build.duckdb, a DuckDB database you can query directly:
    .venv/bin/python -c "import duckdb; print(duckdb.connect('out/build.duckdb').sql('from stations limit 5'))"

Scope: London Underground (LU) and DLR stations only.
Time frames differ on purpose and are never joined on date:
    footfall = typical 2025, step-free routes = station data as published (see FeedInfo.csv).
"""
import csv
import io
import json
import re
import sys
import textwrap
import zipfile
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import duckdb
import openpyxl

from lift_events import GAP_S, load_polls, longest_gap_free_run, outages_from_polls

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
LIFT_DIR = RAW / "lifts"
# The website serves files in public/ as-is, so the wall loads these with fetch('/data/...').
APP_DATA = HERE.parent / "apps" / "website" / "public" / "data"
OUT = HERE / "out"
FOOTFALL_XLSX = RAW / "AC2025_AnnualisedEntryExit_public.xlsx"
STATION_ZIP = RAW / "tfl-stationdata-detailed.zip"

# Footfall modes we keep (LU = Underground). Overground and Elizabeth line are out of scope.
MODES_IN_SCOPE = ("LU", "DLR")
# London = TfL fare zones 1-6. Drops the Metropolitan line's Hertfordshire/Buckinghamshire
# end (zones 7-9: Amersham, Chesham, Watford, ...).
MAX_FARE_ZONE = 6
# Lines whose platforms count when deciding if a station is step-free.
# A hub like Stratford also has National Rail / Elizabeth line platforms; those are ignored.
LINES_IN_SCOPE = {
    "bakerloo", "central", "circle", "district", "hammersmith-city", "jubilee",
    "metropolitan", "northern", "piccadilly", "victoria", "waterloo-city", "dlr",
}

# Footfall station names that don't match the station data by name.
# Value is a list because one footfall row can cover more than one station-data entry.
NAME_OVERRIDES = {
    "Bank and Monument": ["HUBBAN", "940GZZLUMMT"],   # one footfall row, two station records
    "Edgware Road (Bak)": ["940GZZLUERB"],             # Bakerloo station
    "Edgware Road (DIS)": ["940GZZLUERC"],             # Circle/District/H&C station
    "Hammersmith (DIS)": ["HUBHMS"],                   # both Hammersmith stations sit under one hub
    "Hammersmith (H&C)": ["HUBHMS"],
    "Heathrow Terminals 123 LU": ["HUBH13"],
    "Custom House DLR": ["HUBCUS"],
    "Bethnal Green LU": ["940GZZLUBLG"],               # name also used by the Overground station
    "West Hampstead LU": ["940GZZLUWHP"],              # name also used by two rail stations
}
# Wall labels that differ from the station-data name.
DISPLAY_NAME_OVERRIDES = {
    "HUBBAN": "Bank & Monument",   # the footfall row covers both stations
}

# Column positions in the footfall sheet (header rows 5-6, data from row 7).
# Entry columns: Mon, Midweek (Tue-Thu, a daily average), Fri, Sat, Sun. Exits follow in the same order.
FF_MODE, FF_MNLC, FF_NAME, FF_COVERAGE, FF_SOURCE = 0, 1, 3, 4, 5
FF_ENTRY = slice(6, 11)
FF_EXIT = slice(11, 16)
FF_ANNUAL_ENEX = 18
# Days each column stands for in a typical week (Midweek is an average over 3 days).
DAY_WEIGHTS = (1, 3, 1, 1, 1)


def norm_name(name: str) -> str:
    """Lower-case a station name and drop words that differ between datasets."""
    s = name.lower().replace("&", "and").replace("'", "").replace(".", "")
    s = re.sub(r"\b(lu|dlr|underground|station|tfl)\b", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def lowest_fare_zone(fare_zones: str) -> int | None:
    """'2/3' -> 2, '9' -> 9, '' -> None (no zone given)."""
    zones = [int(z) for z in re.split(r"[/|,]", fare_zones) if z.strip().isdigit()]
    return min(zones) if zones else None


def read_zip_csv(z: zipfile.ZipFile, name: str) -> list[dict]:
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


# ---------------------------------------------------------------- footfall

def load_footfall() -> list[tuple]:
    """One tuple per LU/DLR footfall row that has counts (skips '---see LU---' rows)."""
    ws = openpyxl.load_workbook(FOOTFALL_XLSX, read_only=True, data_only=True).worksheets[0]
    rows = []
    for r in list(ws.iter_rows(values_only=True))[7:]:
        if r[FF_MODE] not in MODES_IN_SCOPE:
            continue
        if not isinstance(r[FF_ANNUAL_ENEX], (int, float)):
            continue  # '---see LU---' (counted under another mode) or '---station closed---'
        week_entries = sum(w * v for w, v in zip(DAY_WEIGHTS, r[FF_ENTRY]))
        week_exits = sum(w * v for w, v in zip(DAY_WEIGHTS, r[FF_EXIT]))
        # The sheet only gives an annual total of entries + exits. Keep TfL's annualisation
        # and take the entries' share of a typical week.
        annual_entries = r[FF_ANNUAL_ENEX] * week_entries / (week_entries + week_exits)
        rows.append((
            r[FF_MODE], int(r[FF_MNLC]), r[FF_NAME], r[FF_COVERAGE], r[FF_SOURCE].lower(),
            round(annual_entries),
        ))
    return rows


# ---------------------------------------------------------------- step-free routes

# Graph: area -> set of (neighbour area, lift ID or None). Tagging each link with the lift
# that provides it lets us ask "what if this one lift is broken?" without rebuilding.
Graph = dict[str, set[tuple[str, str | None]]]


def build_station_graph(z: zipfile.ZipFile) -> Graph:
    """Graph of places inside stations joined by step-free links.

    Nodes are station areas (ticket hall, entrance, platform, '-Outside' street point).
    Edges are same-level paths, ramps and lifts. Stairs and escalators are not in these
    tables, so anything reachable from '-Outside' is reachable without steps.
    Links are treated as two-way (checked: one-way gives identical results).
    """
    graph: Graph = defaultdict(set)

    def link(a: str, b: str, lift_id: str | None) -> None:
        a, b = a.strip(), b.strip()
        if a and b and a != b:
            graph[a].add((b, lift_id))
            graph[b].add((a, lift_id))

    for name in ("SameLevelPaths.csv", "RampRoutes.csv"):
        for row in read_zip_csv(z, name):
            link(row["From"], row["To"], None)

    # A lift joins every area on every floor it serves. Each field may list several
    # areas separated by '|'.
    for lift in read_zip_csv(z, "Lifts.csv"):
        areas = [
            a for field in ("FromAreas", "IntermediateAreas", "IntermediateAreas2", "ToAreas")
            for a in lift[field].split("|") if a.strip()
        ]
        for a in areas:
            for b in areas:
                link(a, b, lift["LiftUniqueId"])
    return graph


def reachable_from(graph: Graph, start: str, broken_lift: str | None = None) -> set[str]:
    """Every area you can get to from `start` (depth-first search), optionally with one lift out."""
    seen = {start}
    todo = [start]
    while todo:
        node = todo.pop()
        for nxt, lift_id in graph.get(node, ()):
            if lift_id is not None and lift_id == broken_lift:
                continue
            if nxt not in seen:
                seen.add(nxt)
                todo.append(nxt)
    return seen


def step_free_analysis(z: zipfile.ZipFile) -> tuple[list[tuple], list[tuple]]:
    """Returns (platform_access rows, lift_impact rows) for LU/DLR platforms.

    platform_access: (station_id, platform_id, step_free) - reachable from the street?
    lift_impact:     (station_id, lift_id, platforms_lost) - how many of those step-free
                     platforms become unreachable if this one lift is out of service.
    """
    graph = build_station_graph(z)
    outside = {s["UniqueId"]: s["OutsideStationUniqueId"] for s in read_zip_csv(z, "Stations.csv")}

    platforms_by_station: dict[str, list[str]] = defaultdict(list)
    for p in read_zip_csv(z, "Platforms.csv"):
        if p["IsCustomerFacing"].strip().upper() != "TRUE":
            continue
        # Platform IDs end in the line(s) served, e.g. '...-Plat01-NB-northern' or '...-circle|district'.
        lines = set(p["UniqueId"].split("-", 3)[-1].split("|"))
        if lines & LINES_IN_SCOPE:
            platforms_by_station[p["StationUniqueId"]].append(p["UniqueId"])

    lifts_by_station: dict[str, list[str]] = defaultdict(list)
    for lift in read_zip_csv(z, "Lifts.csv"):
        lifts_by_station[lift["StationUniqueId"]].append(lift["LiftUniqueId"])

    access, impact = [], []
    for sid, platforms in platforms_by_station.items():
        start = outside.get(sid, "")
        reached = reachable_from(graph, start)
        ok_platforms = {p for p in platforms if p in reached}
        access += [(sid, p, p in ok_platforms) for p in platforms]
        # Knock out each lift in turn and count step-free platforms that are lost.
        for lift_id in lifts_by_station.get(sid, []):
            without = reachable_from(graph, start, broken_lift=lift_id)
            impact.append((sid, lift_id, sum(p not in without for p in ok_platforms)))
    return access, impact


# ---------------------------------------------------------------- lookup

def lookup_rows(footfall: list[tuple], stations: list[dict]) -> tuple[list[tuple], list[tuple]]:
    """Map each footfall row (by MNLC) to station-data IDs. Returns (matches, unmatched).

    Each match also gets a `demo_id`: the one ID the wall uses for that station.
    It is the smallest of the row's station IDs, so Bank + Monument become 'HUBBAN',
    and the two Hammersmith rows both map to 'HUBHMS' and are added together.
    """
    by_name: dict[str, list[str]] = defaultdict(list)
    for s in stations:
        by_name[norm_name(s["Name"])].append(s["UniqueId"])

    matches, unmatched = [], []
    for mode, mnlc, name, *_ in footfall:
        ids = NAME_OVERRIDES.get(name)
        if ids is None:
            candidates = by_name.get(norm_name(name), [])
            # Only trust a name match when it is unique; duplicates go in NAME_OVERRIDES.
            ids = candidates if len(candidates) == 1 else None
        if ids is None:
            unmatched.append((mode, mnlc, name))
            continue
        for sid in ids:
            matches.append((mode, mnlc, min(ids), sid))
    return matches, unmatched


# ---------------------------------------------------------------- main

def main() -> int:
    for f in (FOOTFALL_XLSX, STATION_ZIP):
        if not f.exists():
            print(f"missing {f.name}: run python3 fetch.py first")
            return 1
    OUT.mkdir(exist_ok=True)
    db_path = OUT / "build.duckdb"
    db_path.unlink(missing_ok=True)  # rebuild from scratch every run
    con = duckdb.connect(str(db_path))

    footfall = load_footfall()
    with zipfile.ZipFile(STATION_ZIP) as z:
        stations_raw = read_zip_csv(z, "Stations.csv")
        points = read_zip_csv(z, "StationPoints.csv")
        lifts = read_zip_csv(z, "Lifts.csv")
        access, impact = step_free_analysis(z)
        sources = source_versions(z)
    polls, poll_problems = load_polls(LIFT_DIR)
    outages = outages_from_polls(polls)
    lookup, unmatched = lookup_rows(footfall, stations_raw)

    # Load everything into DuckDB so the rest is plain SQL.
    con.execute("""create table footfall (mode text, mnlc int, name text, coverage text,
                   count_method text, annual_entries bigint)""")
    con.executemany("insert into footfall values (?, ?, ?, ?, ?, ?)", footfall)
    con.execute("create table station_lookup (mode text, mnlc int, demo_id text, station_id text)")
    con.executemany("insert into station_lookup values (?, ?, ?, ?)", lookup)
    con.execute("create table station_names (station_id text, name text, zone int)")
    con.executemany("insert into station_names values (?, ?, ?)",
                    [(s["UniqueId"], DISPLAY_NAME_OVERRIDES.get(s["UniqueId"], s["Name"].strip()),
                      lowest_fare_zone(s["FareZones"]))
                     for s in stations_raw])
    con.execute("create table station_points (station_id text, lat double, lon double)")
    con.executemany("insert into station_points values (?, ?, ?)",
                    [(p["StationUniqueId"], float(p["Lat"]), float(p["Lon"])) for p in points])
    con.execute("create table lifts (station_id text, lift_id text)")
    con.executemany("insert into lifts values (?, ?)",
                    [(l["StationUniqueId"], l["LiftUniqueId"]) for l in lifts])
    con.execute("create table platform_access (station_id text, platform_id text, step_free bool)")
    con.executemany("insert into platform_access values (?, ?, ?)", access)
    con.execute("create table lift_impact (station_id text, lift_id text, platforms_lost int)")
    con.executemany("insert into lift_impact values (?, ?, ?)", impact)

    # Lift history: one row per poll, one row per outage event (see lift_events.py for rules).
    con.execute("create table polls (polled_at timestamptz, ok bool, lifts_listed int)")
    con.executemany("insert into polls values (?, ?, ?)",
                    [(p.at, p.ok, len(p.lifts)) for p in polls])
    con.execute("""create table lift_outages (lift_id text, start_at timestamptz, end_at timestamptz,
                   last_seen timestamptz, has_gap bool, start_unknown bool)""")
    con.executemany("insert into lift_outages values (?, ?, ?, ?, ?, ?)",
                    [(o.lift_id, o.start, o.end, o.last_seen, o.has_gap, o.start_unknown)
                     for o in outages])

    # Coverage per UTC day: how many polls, how many failed, how many gaps, and roughly how
    # many hours we actually observed (time between successful polls that are <= 15 min apart).
    con.execute(f"""
        create table coverage as
        with all_polls as (
            select cast(timezone('UTC', polled_at) as date) as day, ok from polls
        ),
        ok_polls as (
            -- seconds since the previous *successful* poll
            select cast(timezone('UTC', polled_at) as date) as day,
                   epoch(polled_at - lag(polled_at) over (order by polled_at)) as since_prev_s
            from polls where ok
        ),
        counts as (
            select day, count(*) as polls, count(*) filter (where not ok) as failed_polls
            from all_polls group by day
        ),
        observed as (
            select day,
                   count(*) filter (where since_prev_s > {GAP_S}) as gaps_over_15_min,
                   round(coalesce(sum(since_prev_s) filter (where since_prev_s <= {GAP_S}), 0) / 3600, 1)
                       as hours_observed
            from ok_polls group by day
        )
        select day, polls, failed_polls,
               coalesce(gaps_over_15_min, 0) as gaps_over_15_min,
               coalesce(hours_observed, 0) as hours_observed
        from counts left join observed using (day)
        order by day
    """)

    # One row per demo station (see lookup_rows for how demo_id is chosen), London only.
    con.execute(f"""
        create table stations as
        with entries as (
            select l.demo_id as id, sum(f.annual_entries) as annual_entries,
                   string_agg(distinct f.name, ' / ') as name,
                   string_agg(distinct f.count_method, ',') as count_method
            -- distinct: Bank and Monument has two lookup rows but its entries count once
            from (select distinct mode, mnlc, demo_id from station_lookup) l
            join footfall f using (mode, mnlc)
            group by l.demo_id
        ),
        ids as (select distinct demo_id as id, station_id from station_lookup),
        pos as (
            select i.id, avg(p.lon) as lon, avg(p.lat) as lat
            from ids i join station_points p using (station_id) group by i.id
        ),
        lift_n as (
            select i.id, count(l.lift_id) as lift_count
            from ids i left join lifts l using (station_id) group by i.id
        ),
        access as (
            select i.id,
                   count(a.platform_id) as platforms,
                   count(a.platform_id) filter (where a.step_free) as step_free_platforms
            from ids i left join platform_access a using (station_id) group by i.id
        ),
        zone as (
            -- a station on a zone boundary (e.g. '2/3') counts as its lower zone
            select i.id, min(n.zone) as fare_zone
            from ids i join station_names n using (station_id) group by i.id
        )
        select e.id,
               -- wall label: the station-data name of the demo ID ('Waterloo', not 'Waterloo LU')
               (select n.name from station_names n where n.station_id = e.id) as display_name,
               e.name, round(pos.lon, 5) as lon, round(pos.lat, 5) as lat,
               e.annual_entries, e.count_method,
               case when a.platforms = 0 then 'unknown'
                    when a.step_free_platforms = 0 then 'none'
                    when a.step_free_platforms = a.platforms then 'full'
                    else 'partial' end as step_free,
               a.platforms, a.step_free_platforms, lift_n.lift_count, zone.fare_zone
        from entries e
        join pos using (id) join lift_n using (id) join access a using (id) join zone using (id)
        where zone.fare_zone <= {MAX_FARE_ZONE}
        order by e.annual_entries desc
    """)
    # Everything after this (findings, lift replay, export) joins through station_lookup,
    # so dropping out-of-scope stations here applies the London scope everywhere.
    dropped = con.sql("""select distinct f.name from station_lookup l join footfall f using (mode, mnlc)
                         where l.demo_id not in (select id from stations) order by 1""").fetchall()
    print(f"outside fare zones 1-{MAX_FARE_ZONE} (left out): {', '.join(r[0] for r in dropped)}")
    con.execute("delete from station_lookup where demo_id not in (select id from stations)")

    # Replay window = longest stretch with no collection gap (see lift_events.py).
    window = longest_gap_free_run(polls)
    if window is None:
        print("no successful lift polls: cannot build the replay")
        return 1
    con.execute("create table replay_window (start_at timestamptz, end_at timestamptz)")
    con.execute("insert into replay_window values (?, ?)", window)

    # Outages at Tube/DLR stations, trimmed to the replay window. Times are whole seconds
    # from the window start, which is what the wall's playhead uses.
    con.execute("""
        create table replay_events as
        with sf as (
            select station_id, count(*) filter (where step_free) as sf_platforms
            from platform_access group by station_id)
        select distinct
               l.demo_id as station,
               o.lift_id as lift,
               cast(epoch(greatest(o.start_at, w.start_at) - w.start_at) as int) as t0,
               cast(epoch(least(coalesce(o.end_at, w.end_at), w.end_at) - w.start_at) as int) as t1,
               -- already out when the window opened / still out when it closed
               o.start_at < w.start_at or o.start_unknown as started_before,
               o.end_at is null or o.end_at > w.end_at as still_out,
               coalesce(i.platforms_lost, 0) > 0 as breaks_route,
               coalesce(i.platforms_lost, 0) > 0 and i.platforms_lost = sf.sf_platforms as all_lost
        from lift_outages o
        cross join replay_window w
        join lifts using (lift_id)
        join station_lookup l using (station_id)
        left join lift_impact i using (lift_id)
        left join sf using (station_id)
        where o.start_at <= w.end_at
          and coalesce(o.end_at, w.end_at) > w.start_at   -- overlaps the window
        order by t0, station, lift
    """)

    report(con, footfall, unmatched)
    print(f"\nlift polls: {len(polls)} read, {len(poll_problems)} lines with problems")
    for problem in poll_problems[:20]:
        print("   ", problem)
    print(con.sql("from coverage"))
    payload = write_findings(con, sources)
    for key, f in payload["findings"].items():
        print(f"\n{key}:")
        result = f["result"]
        for row in (result if isinstance(result, list) else [result]):
            print("   ", row)
    export_app_data(con)
    con.close()
    return 0


# ---------------------------------------------------------------- findings

# Straight-line distance in km between stations a and b (haversine formula, Earth radius 6371 km).
# Straight line, not walking or travel distance: the wall text must say so.
HAVERSINE_KM = """2 * 6371 * asin(sqrt(
        pow(sin(radians(b.lat - a.lat) / 2), 2)
        + cos(radians(a.lat)) * cos(radians(b.lat)) * pow(sin(radians(b.lon - a.lon) / 2), 2)))"""

# Each finding is (key, what it means, SQL). build.py stores the SQL text next to the
# result in findings.json, so every number on the wall traces back to one query.
# 'none' = no Tube/DLR platform reachable step-free from the street.
FINDINGS = [
    (
        "station_counts",
        "Zone A: Tube + DLR stations, and how many have step-free access street-to-platform "
        "(full = every platform, partial = some platforms).",
        """select count(*) as stations_total,
                  count(*) filter (where step_free <> 'none') as stations_with_step_free,
                  count(*) filter (where step_free = 'full') as stations_full,
                  count(*) filter (where step_free = 'partial') as stations_partial,
                  count(*) filter (where step_free = 'none') as stations_none
           from stations""",
    ),
    (
        "headline_entries_share",
        "Finding 1 / zone B headline: share of annual entries (2025) at stations with no "
        "step-free platform. Partial stations are counted as step-free, so this is a lower bound.",
        """select sum(annual_entries) filter (where step_free = 'none') as entries_no_step_free,
                  sum(annual_entries) filter (where step_free = 'partial') as entries_partial,
                  sum(annual_entries) as entries_total,
                  round(100 * entries_no_step_free / entries_total, 1) as pct_no_step_free,
                  round(100 * entries_partial / entries_total, 1) as pct_partial,
                  round(100 * (entries_total - entries_no_step_free - entries_partial)
                        / entries_total, 1) as pct_full_step_free
           from stations""",
    ),
    (
        "busiest_no_step_free",
        "Finding 2a: the 10 busiest stations with no step-free platform, with the nearest "
        "fully step-free station in a straight line.",
        f"""with pairs as (
               select a.id, a.display_name as name, a.annual_entries, b.display_name as nearest_name,
                      {HAVERSINE_KM} as km
               from stations a join stations b on b.step_free = 'full'
               where a.step_free = 'none')
           select id, name, annual_entries,
                  arg_min(nearest_name, km) as nearest_step_free,
                  round(min(km), 1) as km
           from pairs group by id, name, annual_entries
           order by annual_entries desc limit 10""",
    ),
    (
        "furthest_from_step_free",
        "Finding 2b: the 10 stations with no step-free platform that are furthest (straight "
        "line) from a fully step-free station.",
        f"""with pairs as (
               select a.id, a.name, a.annual_entries, b.name as nearest_name,
                      {HAVERSINE_KM} as km
               from stations a join stations b on b.step_free = 'full'
               where a.step_free = 'none')
           select id, name, annual_entries,
                  arg_min(nearest_name, km) as nearest_step_free,
                  round(min(km), 1) as km
           from pairs group by id, name, annual_entries
           order by km desc limit 10""",
    ),
    (
        "busiest_step_free",
        "Insight / zone B: the 5 busiest stations that are step-free to every platform "
        "(the other side of finding 2a).",
        """select id, display_name as name, annual_entries
           from stations where step_free = 'full'
           order by annual_entries desc limit 5""",
    ),
    (
        "single_lift_dependency",
        "Finding 3a / zone D: step-free stations where one lift being out of service removes "
        "step-free access to at least one platform (some_platforms) or to every platform "
        "(all_platforms). From TfL's station route data, not from the outage feed.",
        """with sf as (
               -- step-free platforms per station-data ID (a demo station can have several IDs)
               select station_id, count(*) filter (where step_free) as sf_platforms
               from platform_access group by station_id),
           hit as (
               select distinct l.demo_id, i.lift_id, i.platforms_lost, sf.sf_platforms
               from lift_impact i
               join sf using (station_id)
               join station_lookup l using (station_id)
               where i.platforms_lost > 0)
           select count(distinct demo_id) as stations_some_platforms,
                  count(distinct demo_id) filter (where platforms_lost = sf_platforms)
                      as stations_all_platforms,
                  (select count(*) from stations where step_free <> 'none') as step_free_stations
           from hit""",
    ),
    (
        "lift_window",
        "Finding 3b / zone C: the lift-outage collection window and how much of it was observed.",
        # Timestamps are returned as UTC ISO text: that's what JSON needs anyway.
        """with w as (
               select min(polled_at) filter (where ok) as first_at,
                      max(polled_at) filter (where ok) as last_at,
                      count(*) filter (where ok) as ok_polls,
                      count(*) filter (where not ok) as failed_polls
               from polls)
           select strftime(timezone('UTC', first_at), '%Y-%m-%dT%H:%M:%SZ') as first_poll,
                  strftime(timezone('UTC', last_at), '%Y-%m-%dT%H:%M:%SZ') as last_poll,
                  ok_polls, failed_polls,
                  (select sum(hours_observed) from coverage) as hours_observed,
                  round(epoch(last_at - first_at) / 3600, 1) as hours_in_window
           from w""",
    ),
    (
        "outages_in_scope",
        "Finding 3c / zone C: lift outages seen at Tube/DLR stations in the window, and how many "
        "broke a step-free route (the lift was the only step-free way to some platform).",
        """with o as (
               select distinct o.lift_id, o.start_at, l.demo_id,
                      coalesce(i.platforms_lost, 0) > 0 as broke_route, o.has_gap
               from lift_outages o
               join lifts using (lift_id)
               join station_lookup l using (station_id)
               left join lift_impact i using (lift_id))
           select count(*) as outages,
                  count(distinct demo_id) as stations,
                  count(*) filter (where broke_route) as outages_breaking_route,
                  count(distinct demo_id) filter (where broke_route) as stations_route_broken,
                  count(*) filter (where has_gap) as outages_with_gap
           from o""",
    ),
    (
        "replay",
        "Zone C: the replayed window (longest stretch with no collection gap over 15 min) and "
        "the lift outages at Tube/DLR stations inside it. This is what lift-events.json holds.",
        """select (select strftime(timezone('UTC', start_at), '%Y-%m-%dT%H:%M:%SZ') from replay_window) as window_start,
                  (select strftime(timezone('UTC', end_at), '%Y-%m-%dT%H:%M:%SZ') from replay_window) as window_end,
                  (select round(epoch(end_at - start_at) / 3600, 1) from replay_window) as window_hours,
                  count(*) as outages,
                  count(distinct station) as stations,
                  count(*) filter (where breaks_route) as outages_breaking_route,
                  count(distinct station) filter (where breaks_route) as stations_route_broken,
                  count(distinct station) filter (where all_lost) as stations_lost_all_step_free
           from replay_events""",
    ),
    (
        "replay_impact",
        "Insight / zone C: inside the replayed window, how many hours of broken step-free "
        "routes the outages add up to (summed over lifts), how many outages lasted the whole "
        "window, and the longest single outage that broke a route.",
        """select round(sum(e.t1 - e.t0) filter (where e.breaks_route) / 3600.0, 1) as route_broken_hours,
                  count(*) filter (where e.started_before and e.still_out) as outages_whole_window,
                  arg_max(s.display_name, e.t1 - e.t0) filter (where e.breaks_route) as longest_station,
                  round(max(e.t1 - e.t0) filter (where e.breaks_route) / 3600.0, 1) as longest_hours
           from replay_events e join stations s on s.id = e.station""",
    ),
    (
        "coverage",
        "Method note: lift polls per UTC day, failed polls, gaps over 15 min, hours observed.",
        """select strftime(day, '%Y-%m-%d') as day, polls, failed_polls, gaps_over_15_min, hours_observed
           from coverage order by day""",
    ),
]


def to_json_value(v):
    """DuckDB returns Decimal / int128 for some sums; JSON wants plain int/float."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return v


def write_findings(con, sources: dict) -> dict:
    findings = {}
    for key, description, sql in FINDINGS:
        rel = con.sql(sql)
        rows = [dict(zip(rel.columns, map(to_json_value, r))) for r in rel.fetchall()]
        findings[key] = {
            "description": description,
            # Single-row results are stored as an object so the app can read e.g.
            # findings.headline_entries_share.result.pct_no_step_free directly.
            "result": rows[0] if len(rows) == 1 else rows,
            # The first line of each query starts right after the quotes, so dedent the rest.
            "sql": (lambda first, rest: first.strip() + "\n" + textwrap.dedent(rest).rstrip())(
                *sql.split("\n", 1)),
        }
    payload = {"sources": sources, "findings": findings}
    (OUT / "findings.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
    return payload


def source_versions(z: zipfile.ZipFile) -> dict:
    """Record which version of each input produced these numbers (for the wall's method note)."""
    ws = openpyxl.load_workbook(FOOTFALL_XLSX, read_only=True, data_only=True).worksheets[0]
    footfall_version = next(ws.iter_rows(min_row=5, max_row=5, values_only=True))[1]
    feed = read_zip_csv(z, "FeedInfo.csv")[0]
    return {
        "footfall": {"file": FOOTFALL_XLSX.name, "version": footfall_version,
                     "period": "typical 2025", "measure": "annual entries (derived)"},
        "step_free": {"file": STATION_ZIP.name, "published": feed["FeedStartDate"],
                      "measure": "street-to-platform via same-level paths, ramps and lifts"},
        "scope": f"London Underground + DLR stations in fare zones 1-{MAX_FARE_ZONE}",
    }


# ---------------------------------------------------------------- export for the app

STEP_FREE_CODE = {"none": 0, "partial": 1, "full": 2}


def export_app_data(con) -> None:
    """Write the two compact files the wall loads. Integers wherever possible.

    stations.json     one object per station, busiest first.
    lift-events.json  the replay window and every outage inside it (seconds from window start).
    """
    APP_DATA.mkdir(parents=True, exist_ok=True)

    # 1 when some single lift's failure removes step-free access to every step-free platform.
    one_lift = {r[0] for r in con.sql("""
        with sf as (select station_id, count(*) filter (where step_free) n
                    from platform_access group by station_id)
        select distinct l.demo_id from lift_impact i join sf using (station_id)
        join station_lookup l using (station_id)
        where i.platforms_lost > 0 and i.platforms_lost = sf.n""").fetchall()}

    stations = [
        {
            "id": sid, "name": name, "lon": lon, "lat": lat,
            "entries": int(entries),                 # annual entries, 2025
            "stepFree": STEP_FREE_CODE[step_free],   # 0 none, 1 some platforms, 2 all platforms
            "lifts": int(lifts),
            "oneLift": int(sid in one_lift),
        }
        for sid, name, lon, lat, entries, step_free, lifts in con.sql(
            """select id, display_name, lon, lat, annual_entries, step_free, lift_count
               from stations order by annual_entries desc""").fetchall()
    ]

    [(start, end, seconds)] = con.sql("""
        select strftime(timezone('UTC', start_at), '%Y-%m-%dT%H:%M:%SZ'),
               strftime(timezone('UTC', end_at), '%Y-%m-%dT%H:%M:%SZ'),
               cast(epoch(end_at - start_at) as int)
        from replay_window""").fetchall()
    events = [
        {"station": st, "lift": lift, "t0": t0, "t1": t1,
         "startedBefore": int(sb), "stillOut": int(so),
         "breaksRoute": int(br), "allLost": int(al)}
        for st, lift, t0, t1, sb, so, br, al in con.sql(
            """select station, lift, t0, t1, started_before, still_out, breaks_route, all_lost
               from replay_events order by t0, station, lift""").fetchall()
    ]

    write_json(APP_DATA / "stations.json", {"version": 1, "stations": stations})
    # The wall's text panels read their numbers from here (same file, same SQL, served).
    findings = json.loads((OUT / "findings.json").read_text(encoding="utf-8"))
    write_json(APP_DATA / "findings.json", findings)
    write_json(APP_DATA / "lift-events.json", {
        "version": 1,
        "window": {"start": start, "end": end, "seconds": seconds},
        "events": events,
    })
    print(f"\nexported {len(stations)} stations, {len(events)} lift events "
          f"({start} → {end}) to {APP_DATA}")


def write_json(path: Path, payload) -> None:
    # No indentation or spaces: these files are loaded by every screen on the wall.
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                    encoding="utf-8")


def report(con, footfall, unmatched) -> None:
    total = sum(r[5] for r in footfall)
    lost = sum(r[5] for r in footfall if (r[0], r[1], r[2]) in set(unmatched))
    print(f"footfall rows in scope: {len(footfall)}  (annual entries {total:,})")
    print(f"unmatched rows: {len(unmatched)}  ({lost / total:.2%} of entries)")
    for u in unmatched:
        print("   ", u)
    print(con.sql("select step_free, count(*) stations, sum(annual_entries) entries "
                  "from stations group by 1 order by 2 desc"))
    print(con.sql("select name, step_free, platforms, step_free_platforms, lift_count, annual_entries "
                  "from stations limit 12"))


if __name__ == "__main__":
    sys.exit(main())
