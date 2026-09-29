import pytest

from app.models import Coordinate, PlannedVisit, PlanningRequest
from app.providers.kakao import GeoPoint, RoadMatrix
from app.services.planner import TripPlanner

COORDINATES = {
    "a": Coordinate(latitude=37.50, longitude=127.00),
    "b": Coordinate(latitude=37.51, longitude=127.01),
    "c": Coordinate(latitude=37.30, longitude=126.90),
}


class FakeProvider:
    """Records the legs the planner asked for so call volume stays observable."""

    enabled = True

    def __init__(self, estimated_pairs: set[tuple[int, int]] | None = None) -> None:
        self.requested_pairs: set[tuple[int, int]] | None = None
        self._estimated_pairs = estimated_pairs or set()

    async def geocode_visit(self, visit):
        return PlannedVisit(
            id=visit.id,
            source_row=visit.source_row,
            label=visit.label,
            address=visit.address,
            normalized_address=visit.address,
            coordinate=COORDINATES[visit.id],
            geocode_status="matched",
            original_day=visit.original_day,
            original_order=visit.original_order,
            service_minutes=visit.service_minutes,
            task_count=visit.task_count,
            time_hint=visit.time_hint,
        )

    async def geocode_endpoint(self, address):
        return None

    async def build_road_matrix(self, points: list[GeoPoint], required_pairs=None) -> RoadMatrix:
        self.requested_pairs = required_pairs
        count = len(points)
        values = [[0 if row == column else (abs(row - column) + 1) * 300 for column in range(count)] for row in range(count)]
        return RoadMatrix(
            values,
            [[item * 10 for item in row] for row in values],
            "kakao_road",
            len(self._estimated_pairs),
            set(self._estimated_pairs),
        )

    async def ordered_route_polyline(self, points):
        return []


def build_request(**settings_overrides):
    settings = {"trip_days": 2, "departure_time": "09:00", "default_service_minutes": 20}
    settings.update(settings_overrides)
    return PlanningRequest.model_validate(
        {
            "settings": settings,
            "visits": [
                {"id": "a", "source_row": 2, "label": "A", "address": "AA", "original_day": 1},
                {"id": "b", "source_row": 3, "label": "B", "address": "BB"},
                {"id": "c", "source_row": 4, "label": "C", "address": "CC", "original_day": 2},
            ],
        }
    )


@pytest.mark.asyncio
async def test_planner_keeps_existing_day_and_creates_schedule() -> None:
    result = await TripPlanner(FakeProvider()).plan(build_request())

    visit_by_id = {visit.id: visit for visit in result.visits}
    assert visit_by_id["a"].optimized_day == 1
    assert visit_by_id["c"].optimized_day == 2
    assert sum(len(day.stops) for day in result.days) == 3
    assert all(stop.arrival_time for day in result.days for stop in day.stops)
    assert [day.day_number for day in result.days] == [1, 2]


@pytest.mark.asyncio
async def test_planner_requests_only_same_day_legs() -> None:
    provider = FakeProvider()
    result = await TripPlanner(provider).plan(build_request())

    day_of = {visit.id: visit.optimized_day for visit in result.visits}
    index_of = {"a": 0, "b": 1, "c": 2}
    assert provider.requested_pairs is not None
    for origin, destination in provider.requested_pairs:
        origin_id = next(key for key, value in index_of.items() if value == origin)
        destination_id = next(key for key, value in index_of.items() if value == destination)
        assert day_of[origin_id] == day_of[destination_id], "a cross-day leg can never be driven"


@pytest.mark.asyncio
async def test_day_is_only_labelled_estimated_when_its_own_legs_are() -> None:
    # Visits a and b share day 1; c sits alone on day 2. Estimating the a<->b legs
    # must not taint day 2, whose single stop needs no travel leg at all.
    provider = FakeProvider(estimated_pairs={(0, 1), (1, 0)})
    result = await TripPlanner(provider).plan(build_request())

    by_day = {day.day_number: day for day in result.days}
    assert by_day[1].status == "estimated"
    assert by_day[1].estimated_leg_count == 1
    assert by_day[2].status == "optimized"
    assert by_day[2].estimated_leg_count == 0
    assert result.matrix_source == "estimated"


@pytest.mark.asyncio
async def test_day_totals_carry_service_time_and_task_counts() -> None:
    request = PlanningRequest.model_validate(
        {
            "settings": {"trip_days": 1, "departure_time": "09:00", "default_service_minutes": 20},
            "visits": [
                {"id": "a", "source_row": 2, "label": "A", "address": "AA", "service_minutes": 45, "task_count": 3},
                {"id": "b", "source_row": 3, "label": "B", "address": "BB", "task_count": 2},
            ],
        }
    )

    result = await TripPlanner(FakeProvider()).plan(request)

    day = result.days[0]
    assert day.service_minutes_total == 45 + 20  # the second visit falls back to the default
    assert day.task_count_total == 5
    assert day.stops[0].travel_from_start is False  # no start address was supplied
