#!/usr/bin/env python3
"""Collect TfL's live lift-disruption feed into a local history.

TfL's Disruptions/Lifts/v2 endpoint only says which lifts are broken *right now*.
Polling it every few minutes builds the history the demo's lift replay needs.

Run from this folder (keeps the Mac awake while it runs):
    caffeinate -i python3 collect_lifts.py
Stop with Ctrl+C. Restarting is safe: it only ever appends.

Output: raw/lifts/YYYY-MM-DD.jsonl, one line per poll (UTC date), e.g.
    {"polled_at": "2026-11-03T18:05:00+00:00", "ok": true, "disruptions": [...]}
Every poll is written, even when nothing is broken, so gaps (Mac asleep,
network down) show up as missing timestamps rather than fake "all clear".

Optional: export TFL_APP_KEY=<your key> (free from api-portal.tfl.gov.uk).
Only the Python standard library is used, so there is nothing to install.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://api.tfl.gov.uk/Disruptions/Lifts/v2"
INTERVAL_S = 300  # 5 min: the feed updates about every minute; 5 min is plenty for multi-hour outages
OUT_DIR = Path(__file__).resolve().parent / "raw" / "lifts"
APP_KEY = os.environ.get("TFL_APP_KEY")


def fetch():
    url = URL + (f"?app_key={APP_KEY}" if APP_KEY else "")
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "do-demo-lift-collector/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Writing to {OUT_DIR} every {INTERVAL_S}s. Ctrl+C to stop.", flush=True)
    while True:
        started = time.time()
        now = datetime.now(timezone.utc)
        record = {"polled_at": now.isoformat(timespec="seconds")}
        try:
            record["disruptions"] = fetch()
            record["ok"] = True
        except Exception as exc:  # keep running through network blips
            record["ok"] = False
            record["error"] = f"{type(exc).__name__}: {exc}"

        with (OUT_DIR / f"{now:%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

        status = len(record["disruptions"]) if record["ok"] else record["error"]
        print(f"{record['polled_at']}  stations with a broken lift: {status}", flush=True)
        time.sleep(max(0.0, INTERVAL_S - (time.time() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
