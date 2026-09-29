from app.analysis.partition import assign_days
from app.models import Coordinate, PlannedVisit


def visit(identifier: str, latitude: float, longitude: float, day: int | None = None) -> PlannedVisit:
    return PlannedVisit(
        id=identifier,
        source_row=1,
        label=identifier,
        address=f"address {identifier}",
        coordinate=Coordinate(latitude=latitude, longitude=longitude),
        geocode_status="matched",
        original_day=day,
    )


def test_existing_day_is_preserved_and_remaining_visit_is_assigned() -> None:
    visits = [
        visit("fixed", 37.50, 127.00, day=2),
        visit("north", 37.60, 127.10),
        visit("south", 37.30, 126.90),
    ]

    assignments, warnings = assign_days(visits, trip_days=2)

    assert assignments["fixed"] == 2
    assert set(assignments) == {"fixed", "north", "south"}
    assert not warnings


def test_out_of_range_existing_day_is_reassigned_with_warning() -> None:
    assignments, warnings = assign_days([visit("late", 37.50, 127.00, day=4)], trip_days=2)

    assert assignments["late"] in {1, 2}
    assert len(warnings) == 1


def test_a_dense_cluster_cannot_swallow_more_than_the_capacity_ceiling() -> None:
    # Eight visits sit on top of each other and two sit far away. Proximity alone would
    # put all eight on one day; the ceiling has to spread them.
    visits = [visit(f"cluster-{index}", 37.50 + index * 0.001, 127.00) for index in range(8)]
    visits += [visit("far-1", 35.10, 129.00), visit("far-2", 35.11, 129.01)]

    assignments, _ = assign_days(visits, trip_days=2)

    per_day = [sum(1 for day in assignments.values() if day == number) for number in (1, 2)]
    assert sum(per_day) == 10
    assert max(per_day) <= 7, f"one day took {max(per_day)} of 10 visits"


def test_service_minutes_balance_days_rather_than_row_counts() -> None:
    # Two long visits should not share a day with four short ones just because the counts match.
    visits = [visit("long-1", 37.50, 127.00), visit("long-2", 37.501, 127.001)]
    visits += [visit(f"short-{index}", 37.502 + index * 0.001, 127.002) for index in range(4)]
    weights = {"long-1": 240.0, "long-2": 240.0, "short-1": 20.0, "short-2": 20.0, "short-3": 20.0, "short-0": 20.0}

    assignments, _ = assign_days(visits, trip_days=2, weights=weights)

    loads = [sum(weights[key] for key, day in assignments.items() if day == number) for number in (1, 2)]
    assert max(loads) <= min(loads) * 2, f"day loads {loads} are lopsided"
