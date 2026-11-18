#!/usr/bin/env python3
"""Download the raw TfL datasets the pipeline needs into raw/.

Run from this folder:
    python3 fetch.py

Re-runnable: a file that already exists is skipped, so the raw data stays
fixed once downloaded (delete a file to fetch it again). The lift history
in raw/lifts/ is not fetched here; collect_lifts.py builds it over time.

Optional: export TFL_APP_KEY=<your key> to avoid anonymous rate limits.
Only the Python standard library is used.
"""
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

RAW_DIR = Path(__file__).resolve().parent / "raw"
APP_KEY = os.environ.get("TFL_APP_KEY")
USER_AGENT = "do-demo-pipeline/1.0"

# name on disk -> (url, needs TfL API key appended?)
DATASETS = {
    # 1. Annualised station entries/exits, 2025 (TfL crowding open data).
    #    (Numbering follows BRIEF.md; dataset 3, the lift history, comes from collect_lifts.py.)
    "AC2025_AnnualisedEntryExit_public.xlsx": (
        "https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk/"
        "Annual%20Station%20Counts/2025/AC2025_AnnualisedEntryExit_public.xlsx",
        False,
    ),
    # 2. TfL station data (detailed): Stations.csv, Platforms.csv, StationPoints.csv (with
    #    coordinates), Lifts.csv, and the ramp/same-level path tables describing step-free
    #    routes inside each station. Lift IDs match the Disruptions/Lifts/v2 feed.
    #    build.py reads the CSVs straight from the zip, so nothing is extracted to disk.
    #    (The StopPoint API was dropped: its AccessViaLift field is missing for most stations.)
    "tfl-stationdata-detailed.zip": (
        "https://api.tfl.gov.uk/stationdata/tfl-stationdata-detailed.zip",
        True,
    ),
}


def download(url: str, dest: Path, use_key: bool) -> None:
    if use_key and APP_KEY:
        url += ("&" if "?" in url else "?") + f"app_key={APP_KEY}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    # Write to a temp file first so a failed download never leaves a half file
    # that the "skip if present" check would then trust.
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:
        while chunk := resp.read(1 << 16):
            out.write(chunk)
    tmp.rename(dest)


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    failed = 0
    for name, (url, use_key) in DATASETS.items():
        dest = RAW_DIR / name
        if dest.exists():
            print(f"skip  {name} (already present, {dest.stat().st_size:,} bytes)")
            continue
        print(f"fetch {name} ...", flush=True)
        try:
            download(url, dest, use_key)
        except Exception as exc:
            failed += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
            continue
        print(f"ok    {name} ({dest.stat().st_size:,} bytes)")

    # Quick sanity check: the zip really is a zip, not an HTML error page.
    sd = RAW_DIR / "tfl-stationdata-detailed.zip"
    if sd.exists() and not zipfile.is_zipfile(sd):
        print(f"WARN  {sd.name} is not a valid zip; delete it and re-run.")
        failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
