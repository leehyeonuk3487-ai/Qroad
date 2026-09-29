import pytest

from app.analysis.timewindow import check_arrival, parse_time_hint


@pytest.mark.parametrize(
    ("raw", "kind", "minute_of_day"),
    [
        ("09:00", "at", 9 * 60),
        ("10:30 방문", "at", 10 * 60 + 30),
        ("13:00까지 도착", "before", 13 * 60),
        ("14시 이후", "after", 14 * 60),
        ("오후 2시", "at", 14 * 60),
        ("오전 9시 30분", "at", 9 * 60 + 30),
        ("오후 12시", "at", 12 * 60),
        ("오전 12시", "at", 0),
    ],
)
def test_an_exact_note_becomes_a_checkable_bound(raw: str, kind: str, minute_of_day: int) -> None:
    constraint = parse_time_hint(raw)

    assert constraint is not None
    assert constraint.kind == kind
    assert constraint.minute_of_day == minute_of_day
    assert constraint.raw == raw


@pytest.mark.parametrize("raw", ["오전", "오후 방문", "점심 전", "저녁 무렵", "편한 시간"])
def test_a_loose_note_is_kept_but_never_turned_into_a_clock_time(raw: str) -> None:
    constraint = parse_time_hint(raw)

    assert constraint is not None
    assert constraint.kind == "vague"
    assert constraint.minute_of_day is None, "a vague note must not be presented as an exact time"
    assert constraint.raw == raw


def test_no_note_produces_no_constraint() -> None:
    assert parse_time_hint(None) is None
    assert parse_time_hint("   ") is None


def test_an_impossible_clock_reading_is_not_forced_into_a_time() -> None:
    assert parse_time_hint("25:00").minute_of_day is None
    assert parse_time_hint("12:75").minute_of_day is None


class TestCheckArrival:
    def test_a_deadline_is_flagged_only_when_missed(self) -> None:
        deadline = parse_time_hint("13:00까지")

        assert check_arrival(deadline, 12 * 60 + 59) == "ok"
        assert check_arrival(deadline, 13 * 60 + 1) == "late"

    def test_an_earliest_time_is_flagged_only_when_beaten(self) -> None:
        earliest = parse_time_hint("14시 이후")

        assert check_arrival(earliest, 14 * 60 + 10) == "ok"
        assert check_arrival(earliest, 13 * 60 + 30) == "early"

    def test_a_planned_time_tolerates_an_hour_of_drift(self) -> None:
        planned = parse_time_hint("10:00 방문")

        assert check_arrival(planned, 10 * 60 + 45) == "ok"
        assert check_arrival(planned, 11 * 60 + 30) == "shifted"

    def test_a_loose_note_is_never_judged(self) -> None:
        assert check_arrival(parse_time_hint("오전"), 23 * 60) is None
        assert check_arrival(None, 9 * 60) is None
