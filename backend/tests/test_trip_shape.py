"""How a trip's anchors, workload and baseline are shaped by the settings."""

import pytest

from app.models import Coordinate, PlannedVisit, PlanningRequest
from app.providers.kakao import GeoPoint, RoadMatrix
from app.services.planner import TripPlanner

ANCHORS = {
    "청사": Coordinate(latitude=35.87, longitude=128.60),
    "숙소": Coordinate(latitude=36.30, longitude=127.40),
    "자택": Coordinate(latitude=35.80, longitude=128.50),
}


class FakeProvider:
    enabled = True

    def __init__(self) -> None:
        self.requested_pairs: set[tuple[int, int]] | None = None

    async def geocode_visit(self, visit):
        index = int(visit.id.split("-")[1])
        return PlannedVisit(
            id=visit.id,
            source_row=visit.source_row,
            label=visit.label,
            address=visit.address,
            normalized_address=visit.address,
            coordinate=Coordinate(latitude=36.0 + index * 0.05, longitude=127.0 + index * 0.05),
            geocode_status="matched",
            original_day=visit.original_day,
            original_order=visit.original_order,
            service_minutes=visit.service_minutes,
            task_count=visit.task_count,
            time_hint=visit.time_hint,
        )

    async def geocode_endpoint(self, address):
        return ANCHORS.get(address) if address else None

    async def build_road_matrix(self, points: list[GeoPoint], required_pairs=None) -> RoadMatrix:
        self.requested_pairs = required_pairs
        count = len(points)
        values = [[0 if a == b else (abs(a - b) + 1) * 600 for b in range(count)] for a in range(count)]
        return RoadMatrix(values, [[v * 9 for v in row] for row in values], "kakao_road", 0, set())

    async def ordered_route_polyline(self, points):
        return []


async def plan(settings: dict, visits: list[dict]) -> tuple:
    provider = FakeProvider()
    request = PlanningRequest.model_validate({"settings": settings, "visits": visits})
    return await TripPlanner(provider).plan(request), provider


def simple_visits(count: int, **extra) -> list[dict]:
    return [
        {"id": f"v-{i}", "source_row": i + 2, "label": f"L{i}", "address": f"주소 {i}", **extra}
        for i in range(count)
    ]


class TestLodging:
    @pytest.mark.asyncio
    async def test_nights_chain_through_the_lodging_address(self) -> None:
        result, _ = await plan(
            {"trip_days": 3, "start_address": "청사", "end_address": "자택", "lodging_address": "숙소"},
            simple_visits(6),
        )

        first, middle, last = result.days
        assert (first.start.kind, first.end.kind) == ("start", "lodging")
        assert (middle.start.kind, middle.end.kind) == ("lodging", "lodging")
        assert (last.start.kind, last.end.kind) == ("lodging", "end")

    @pytest.mark.asyncio
    async def test_without_lodging_every_day_shares_one_base(self) -> None:
        result, _ = await plan(
            {"trip_days": 3, "start_address": "청사", "end_address": "자택"},
            simple_visits(6),
        )

        for day in result.days:
            assert day.start.kind == "start"
            assert day.end.kind == "end"

    @pytest.mark.asyncio
    async def test_a_one_day_trip_ignores_lodging_and_says_so(self) -> None:
        result, _ = await plan(
            {"trip_days": 1, "start_address": "청사", "end_address": "자택", "lodging_address": "숙소"},
            simple_visits(3),
        )

        assert result.days[0].end.kind == "end"
        assert any("숙박지" in issue.message for issue in result.issues)

    @pytest.mark.asyncio
    async def test_an_unresolvable_lodging_address_warns_instead_of_failing(self) -> None:
        result, _ = await plan(
            {"trip_days": 2, "lodging_address": "존재하지 않는 곳"},
            simple_visits(4),
        )

        assert sum(len(day.stops) for day in result.days) == 4
        assert any("숙박지 주소를 찾지 못해" in issue.message for issue in result.issues)

    @pytest.mark.asyncio
    async def test_each_day_prices_only_its_own_anchors(self) -> None:
        _, provider = await plan(
            {"trip_days": 3, "start_address": "청사", "end_address": "자택", "lodging_address": "숙소"},
            simple_visits(6),
        )

        # Six visits occupy indices 0-5, then start, end and lodging are appended in order.
        start_index, end_index, lodging_index = 6, 7, 8
        origins = {origin for origin, _ in provider.requested_pairs}
        destinations = {destination for _, destination in provider.requested_pairs}
        assert lodging_index in origins and lodging_index in destinations
        assert start_index in origins
        assert end_index in destinations
        assert start_index not in destinations, "nothing ever drives back to the start anchor"


class TestWorkload:
    @pytest.mark.asyncio
    async def test_minutes_per_task_extends_the_default_stay(self) -> None:
        result, _ = await plan(
            {"trip_days": 1, "default_service_minutes": 30, "minutes_per_task": 15},
            [{"id": "v-0", "source_row": 2, "label": "L0", "address": "주소", "task_count": 4}],
        )

        assert result.days[0].stops[0].service_minutes == 30 + 4 * 15

    @pytest.mark.asyncio
    async def test_an_explicit_stay_wins_over_the_task_rate(self) -> None:
        result, _ = await plan(
            {"trip_days": 1, "default_service_minutes": 30, "minutes_per_task": 15},
            [{"id": "v-0", "source_row": 2, "label": "L0", "address": "주소", "task_count": 4, "service_minutes": 20}],
        )

        assert result.days[0].stops[0].service_minutes == 20

    @pytest.mark.asyncio
    async def test_task_counts_alone_change_nothing_until_a_rate_is_set(self) -> None:
        result, _ = await plan(
            {"trip_days": 1, "default_service_minutes": 30},
            [{"id": "v-0", "source_row": 2, "label": "L0", "address": "주소", "task_count": 9}],
        )

        assert result.days[0].stops[0].service_minutes == 30


class TestBaseline:
    @pytest.mark.asyncio
    async def test_the_original_sequence_is_returned_for_comparison(self) -> None:
        visits = [
            {"id": "v-0", "source_row": 2, "label": "L0", "address": "주소 0", "original_day": 1, "original_order": 3},
            {"id": "v-1", "source_row": 3, "label": "L1", "address": "주소 1", "original_day": 1, "original_order": 1},
            {"id": "v-2", "source_row": 4, "label": "L2", "address": "주소 2", "original_day": 1, "original_order": 2},
        ]

        result, _ = await plan({"trip_days": 1}, visits)

        day = result.days[0]
        assert day.baseline_order == ["v-1", "v-2", "v-0"]
        assert day.baseline_metrics is not None
        assert len(day.baseline_order) == len(day.stops)

    @pytest.mark.asyncio
    async def test_no_original_order_means_no_baseline_to_compare_against(self) -> None:
        result, _ = await plan({"trip_days": 1}, simple_visits(3))

        assert result.days[0].baseline_order == []
        assert result.days[0].baseline_metrics is None


class TestTimeConstraints:
    @pytest.mark.asyncio
    async def test_a_missed_deadline_is_reported_against_its_source_row(self) -> None:
        visits = simple_visits(4)
        visits[0]["time_hint"] = "09:05까지 도착"

        result, _ = await plan({"trip_days": 1, "departure_time": "09:00"}, visits)

        stops = [stop for day in result.days for stop in day.stops if stop.visit_id == "v-0"]
        assert stops[0].time_constraint is not None
        late = [issue for issue in result.issues if issue.kind == "time_constraint" and issue.severity == "warning"]
        assert any(issue.visit_id == "v-0" and issue.source_row == 2 for issue in late)

    @pytest.mark.asyncio
    async def test_a_vague_note_never_raises_a_violation(self) -> None:
        visits = simple_visits(4)
        visits[0]["time_hint"] = "오전"

        result, _ = await plan({"trip_days": 1, "departure_time": "09:00"}, visits)

        assert all(stop.time_status is None for day in result.days for stop in day.stops)
        assert not [issue for issue in result.issues if issue.kind == "time_constraint" and issue.severity == "warning"]
