"""Tests for the outage rules in lift_events.py.  Run:  python3 -m unittest test_lift_events"""
import unittest
from datetime import datetime, timedelta, timezone

from lift_events import Poll, longest_gap_free_run, outages_from_polls

T0 = datetime(2026, 11, 10, 8, 0, tzinfo=timezone.utc)


def polls(*specs):
    """specs: (minutes after T0, lift IDs listed) or (minutes, None) for a failed poll."""
    return [
        Poll(T0 + timedelta(minutes=m), lifts is not None, frozenset(lifts or ()))
        for m, lifts in specs
    ]


class OutageRules(unittest.TestCase):
    def test_ends_after_two_clear_polls(self):
        [o] = outages_from_polls(polls((0, []), (5, ["L1"]), (10, ["L1"]), (15, []), (20, [])))
        self.assertEqual(o.start, T0 + timedelta(minutes=5))
        self.assertEqual(o.end, T0 + timedelta(minutes=15))  # first poll seen working
        self.assertFalse(o.has_gap)
        self.assertFalse(o.start_unknown)

    def test_single_missing_poll_is_a_blip(self):
        out = outages_from_polls(polls((0, []), (5, ["L1"]), (10, []), (15, ["L1"]), (20, []), (25, [])))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].end, T0 + timedelta(minutes=20))

    def test_failed_polls_are_not_evidence_of_working(self):
        # Two failed polls between sightings must not close the outage.
        out = outages_from_polls(polls((0, []), (5, ["L1"]), (10, None), (15, None), (20, ["L1"])))
        self.assertEqual(len(out), 1)
        self.assertIsNone(out[0].end)  # still open at the last poll

    def test_gap_inside_outage_is_flagged(self):
        [o] = outages_from_polls(polls((0, []), (5, ["L1"]), (65, ["L1"]), (70, []), (75, [])))
        self.assertTrue(o.has_gap)

    def test_outage_seen_first_after_gap_has_unknown_start(self):
        [o] = outages_from_polls(polls((0, []), (60, ["L1"]), (65, []), (70, [])))
        self.assertTrue(o.start_unknown)


class ReplayWindow(unittest.TestCase):
    def test_picks_longest_run_and_ignores_failed_polls(self):
        p = polls((0, []), (5, []),                       # run 1: 5 min
                  (60, []), (65, None), (70, []), (75, []))  # run 2: 15 min (failed poll inside is fine: 70-60 <= 15)
        self.assertEqual(longest_gap_free_run(p),
                         (T0 + timedelta(minutes=60), T0 + timedelta(minutes=75)))


if __name__ == "__main__":
    unittest.main()
