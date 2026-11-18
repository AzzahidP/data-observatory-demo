"""Turn the raw lift-disruption polls (raw/lifts/*.jsonl) into outage events.

Used by build.py. Pure functions only (no database), so the rules are easy to test.

Rules:
- Only successful polls count as evidence. A failed poll ("ok": false) or a missing
  poll tells us nothing, so it is treated as unknown, never as "working".
- An outage of a lift STARTS at the first successful poll that lists it.
- It ENDS at the first of two consecutive successful polls that no longer list it
  (about 10 minutes of "fixed"). One missing poll followed by the lift reappearing is
  treated as a blip inside the same outage.
- has_gap: somewhere between the start and the end there was a stretch longer than
  GAP_S with no successful poll, so we can't be sure the lift stayed out the whole time.
- start_unknown: the lift was already listed in the first poll after a gap (or the
  first poll ever), so the real start was earlier than `start`.
- end is None when the outage is still open at the last poll.
"""
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

GAP_S = 15 * 60          # longer than this between successful polls = a collection gap
POLLS_TO_CLOSE = 2       # consecutive successful polls without the lift to call it fixed


@dataclass(frozen=True)
class Poll:
    at: datetime
    ok: bool
    lifts: frozenset[str]   # lift IDs listed as disrupted (empty for failed polls)


@dataclass
class Outage:
    lift_id: str
    start: datetime
    end: datetime | None = None
    last_seen: datetime | None = None
    has_gap: bool = False
    start_unknown: bool = False
    misses: int = 0          # consecutive successful polls without this lift (internal)


def load_polls(lift_dir: Path) -> tuple[list[Poll], list[str]]:
    """Read every *.jsonl file. Returns (polls sorted by time, problems found)."""
    polls, problems = [], []
    for path in sorted(lift_dir.glob("*.jsonl")):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            where = f"{path.name}:{line_no}"
            try:
                rec = json.loads(line)
                at = datetime.fromisoformat(rec["polled_at"])
                ok = rec["ok"]
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                # Don't guess at unfamiliar formats (e.g. a different collector); report them.
                problems.append(f"{where}: unreadable ({type(exc).__name__}: {exc})")
                continue
            if ok is not True:
                polls.append(Poll(at, False, frozenset()))
                continue
            lifts = set()
            for d in rec.get("disruptions") or []:
                ids = d.get("disruptedLiftUniqueIds") if isinstance(d, dict) else None
                if not isinstance(ids, list):
                    problems.append(f"{where}: disruption without disruptedLiftUniqueIds")
                    continue
                lifts.update(i for i in ids if isinstance(i, str))
            polls.append(Poll(at, True, frozenset(lifts)))
    polls.sort(key=lambda p: p.at)
    return polls, problems


def longest_gap_free_run(polls: list[Poll]) -> tuple[datetime, datetime] | None:
    """(first, last) time of the longest run of successful polls with no gap over GAP_S.

    This is the window the wall replays: inside it we never stopped watching, so
    "not listed" really does mean "working".
    """
    ok_times = [p.at for p in polls if p.ok]
    if not ok_times:
        return None
    best = cur = (ok_times[0], ok_times[0])
    for prev, at in zip(ok_times, ok_times[1:]):
        if (at - prev).total_seconds() > GAP_S:
            cur = (at, at)          # gap: start a new run
        else:
            cur = (cur[0], at)      # extend the current run
        if cur[1] - cur[0] > best[1] - best[0]:
            best = cur
    return best


def outages_from_polls(polls: list[Poll]) -> list[Outage]:
    """Walk the successful polls in time order and open/close one outage per lift."""
    ok_polls = [p for p in polls if p.ok]
    open_: dict[str, Outage] = {}
    done: list[Outage] = []
    prev_at: datetime | None = None

    for poll in ok_polls:
        # Was there a collection gap just before this poll?
        gap_before = prev_at is None or (poll.at - prev_at).total_seconds() > GAP_S
        if gap_before:
            for o in open_.values():
                o.has_gap = True  # we were blind for a while during this outage

        # Lifts listed now: continue their outage, or start a new one.
        for lift_id in poll.lifts:
            o = open_.get(lift_id)
            if o is None:
                open_[lift_id] = Outage(lift_id, start=poll.at, last_seen=poll.at,
                                        start_unknown=gap_before)
            else:
                o.last_seen = poll.at
                o.misses = 0

        # Lifts not listed now: count a miss; close after POLLS_TO_CLOSE misses in a row.
        for lift_id in [l for l in open_ if l not in poll.lifts]:
            o = open_[lift_id]
            o.misses += 1
            if o.misses == 1:
                o.end = poll.at          # provisional: first poll it was seen working
            if o.misses >= POLLS_TO_CLOSE:
                done.append(open_.pop(lift_id))
        # A lift that reappears after one miss keeps its outage; drop the provisional end.
        for o in open_.values():
            if o.misses == 0:
                o.end = None
        prev_at = poll.at

    # Still open (or only one miss) at the last poll: the end is unknown.
    for o in open_.values():
        o.end = None
        done.append(o)
    done.sort(key=lambda o: (o.start, o.lift_id))
    return done
