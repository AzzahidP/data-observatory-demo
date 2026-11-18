# Pipeline: "The step-free gap"

Offline data preparation for the Data Observatory demo. The wall never calls TfL at
runtime; it only loads the files this pipeline writes.

## Run

```bash
cd pipeline
python3 -m venv .venv && .venv/bin/pip install duckdb openpyxl   # once
python3 fetch.py                  # download raw files (skips files already present)
.venv/bin/python build.py         # build tables, findings and app data
python3 -m unittest test_lift_events   # tests for the lift-outage rules
```

Lift history is collected separately and continuously by `collect_lifts.py`
(running with 5 minute intervals on a VM). Copy new
`raw/lifts/YYYY-MM-DD.jsonl` files in and re-run `build.py`.

## Inputs (`raw/`)

| File                                     | Source                                                        | Period                                  |
| ---------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `AC2025_AnnualisedEntryExit_public.xlsx` | TfL crowding data, annualised station entries/exits           | typical 2025                            |
| `tfl-stationdata-detailed.zip`           | TfL station data: stations, platforms, lifts, step-free paths | as published (`FeedInfo.csv`, Oct 2026) |
| `lifts/*.jsonl`                          | `collect_lifts.py` polling `Disruptions/Lifts/v2` every 5 min | 2026-11-11 ~ 2026-11-17                 |

## Outputs

| File                                           | What it is                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out/findings.json`                            | Every number for the wall, each stored with the SQL query that produced it, plus source versions                                                                                          |
| `out/build.duckdb`                             | All intermediate tables, for checking (not committed)                                                                                                                                     |
| `../apps/website/public/data/stations.json`    | One object per station: `id, name, lon, lat, entries` (annual 2025), `stepFree` (0 none, 1 some platforms, 2 all), `lifts`, `oneLift` (1 = one lift failing removes all step-free access) |
| `../apps/website/public/data/lift-events.json` | `window` (start, end, seconds) and `events`: `station, lift, t0, t1` (seconds from window start), `startedBefore, stillOut, breaksRoute, allLost` (0/1)                                   |

## Method

1. **Scope:** London Underground and DLR stations from the footfall file (307 stations).
2. **Entries:** the file gives annual entries + exits combined. Annual entries =
   that total × the entries' share of a typical week (Mon + 3×Tue–Thu + Fri + Sat + Sun).
   DLR stations have no gates: their counts come from on-train passenger counters (`apc`).
3. **Station lookup:** footfall names are matched to station-data IDs by normalised name;
   9 exceptions are listed in `NAME_OVERRIDES` in `build.py`. Unmatched rows are printed
   with their share of entries (currently 0).
4. **Step-free (street to platform):** inside each station, areas are joined by
   same-level paths, ramps and lifts (stairs and escalators are not in these tables).
   A platform is step-free if it can be reached from the station's street point.
   A station is _full_ (all its Tube/DLR platforms), _partial_ (some) or _none_.
   This is street-to-platform, not platform-to-train (gaps and steps onto trains are not included).
5. **One-lift dependency:** each lift is removed in turn and the search re-run; the
   station depends on one lift if that removes step-free access to every platform.
6. **Lift outages** (`lift_events.py`): an outage starts at the first successful poll
   listing the lift and ends at the first of two consecutive successful polls without it.
   Failed or missing polls are _unknown_, never "working". `has_gap` marks outages with
   a gap over 15 min inside; `start_unknown` marks outages already present after a gap.
7. **Replay window:** the longest stretch of successful polls with no gap over 15 min.
   Outages are trimmed to it; `startedBefore` / `stillOut` mark the trimmed ends.

## Caveats (say these on the wall or in the method note)

- Time frames differ on purpose: footfall = typical 2025, step-free routes = station
  data as published, lift outages = the replay window. They are joined on station, never on date.
- Entries are taps (or counter readings), not people: say "journeys" or "entries".
- Distances to the nearest step-free station are straight lines, not routes, and only
  count Tube/DLR stations as alternatives.
- Partial stations count as step-free in the headline, so the headline share is a lower bound.
- The lift feed is a 5-minute poll: outages shorter than that can be missed. The current
  data (11–17 Nov 2026) has no failed polls and no gaps, so the replay window is the whole week.
