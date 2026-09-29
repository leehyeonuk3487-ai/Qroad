from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta

from app.analysis.optimizer import calculate_metrics, day_search_budgets, optimize_path
from app.analysis.partition import assign_days
from app.analysis.timewindow import check_arrival, parse_time_hint
from app.models import (
    Coordinate,
    DayPlan,
    PlanIssue,
    PlannedVisit,
    PlanningRequest,
    PlanningResponse,
    RouteEndpoint,
    RouteMetrics,
    RouteStop,
    TripSettings,
)
from app.providers.kakao import GeoPoint, KakaoProvider


class TripPlanner:
    def __init__(self, provider: KakaoProvider) -> None:
        self._provider = provider

    async def plan(self, request: PlanningRequest) -> PlanningResponse:
        visits = await self._geocode_visits(request)
        for visit in visits:
            visit.time_constraint = parse_time_hint(visit.time_hint)
        issues = _geocode_issues(visits, self._provider.enabled)
        issues.extend(_time_hint_issues(visits))
        routable = [visit for visit in visits if visit.coordinate]
        if not routable:
            return PlanningResponse(
                visits=visits,
                days=[],
                issues=issues,
                matrix_source="estimated",
                partition_basis="주소 좌표를 확인할 수 없어 배정을 시작하지 않았습니다.",
                optimization_status="partial",
            )

        start_coordinate, end_coordinate, lodging_coordinate = await asyncio.gather(
            self._provider.geocode_endpoint(request.settings.start_address),
            self._provider.geocode_endpoint(request.settings.end_address),
            self._provider.geocode_endpoint(request.settings.lodging_address),
        )
        for address, coordinate, name in (
            (request.settings.start_address, start_coordinate, "출발지"),
            (request.settings.end_address, end_coordinate, "종료지"),
            (request.settings.lodging_address, lodging_coordinate, "숙박지"),
        ):
            if address and not coordinate:
                issues.append(
                    PlanIssue(
                        kind="settings",
                        severity="warning",
                        message=f"{name} 주소를 찾지 못해 {name} 없이 계산했습니다.",
                    )
                )
        if lodging_coordinate and request.settings.trip_days == 1:
            issues.append(
                PlanIssue(
                    kind="settings",
                    severity="info",
                    message="출장이 하루여서 숙박지는 경로에 반영하지 않았습니다.",
                )
            )

        weights = {
            visit.id: _visit_workload(visit, request.settings)
            for visit in routable
        }
        assignments, partition_warnings = assign_days(routable, request.settings.trip_days, weights)
        for warning in partition_warnings:
            issues.append(PlanIssue(kind="settings", severity="warning", message=warning))
        for visit in routable:
            visit.optimized_day = assignments[visit.id]

        points = [GeoPoint(visit.id, visit.coordinate) for visit in routable]
        point_index = {point.id: index for index, point in enumerate(points)}
        anchors = _Anchors.build(
            points, request.settings, start_coordinate, end_coordinate, lodging_coordinate
        )

        day_groups = {
            day_number: [visit for visit in routable if visit.optimized_day == day_number]
            for day_number in range(1, request.settings.trip_days + 1)
        }
        required_pairs = _required_legs(day_groups, point_index, anchors)
        matrix = await self._provider.build_road_matrix(points, required_pairs)
        if matrix.estimated_edges:
            issues.append(
                PlanIssue(
                    kind="routing_fallback",
                    severity="warning",
                    message=(
                        "일부 이동 구간은 도로 길찾기 응답을 받지 못해 거리 기반 추정치로 계산했습니다. "
                        "결과의 '추정' 표기를 확인해 주세요."
                    ),
                )
            )

        has_baseline = any(visit.original_day is not None or visit.original_order is not None for visit in routable)
        budgets = dict(
            zip(day_groups, day_search_budgets([len(members) for members in day_groups.values()]), strict=True)
        )
        days = await asyncio.gather(
            *(
                self._plan_day(
                    day_number,
                    day_visits,
                    budgets[day_number],
                    point_index,
                    matrix,
                    anchors,
                    request.settings,
                    has_baseline,
                )
                for day_number, day_visits in day_groups.items()
            )
        )
        days = sorted(days, key=lambda day: day.day_number)
        for day in days:
            issues.extend(_capacity_issues(day))
        issues.extend(_time_violation_issues(days, visits))

        partial = bool([visit for visit in visits if not visit.coordinate]) or matrix.estimated_edges > 0
        return PlanningResponse(
            visits=visits,
            days=days,
            issues=issues,
            matrix_source=(
                "kakao_road" if matrix.source == "kakao_road" and not matrix.estimated_edges else "estimated"
            ),
            partition_basis=(
                "원본 일차는 유지하고, 미배정 방문지는 좌표 근접성과 일차별 체류시간 합계의 균형을 기준으로 배정했습니다. "
                "전역 최적해 보장은 아닙니다."
                if any(visit.original_day is not None for visit in routable)
                else "좌표 근접성과 일차별 체류시간 합계의 균형을 기준으로 배정했습니다. 전역 최적해 보장은 아닙니다."
            ),
            optimization_status="partial" if partial else "completed",
        )

    async def _geocode_visits(self, request: PlanningRequest) -> list[PlannedVisit]:
        semaphore = asyncio.Semaphore(5)

        async def geocode(visit):
            async with semaphore:
                return await self._provider.geocode_visit(visit)

        return await asyncio.gather(*(geocode(visit) for visit in request.visits))

    async def _plan_day(
        self,
        day_number: int,
        visits: list[PlannedVisit],
        search_budget_ms: int,
        point_index: dict[str, int],
        matrix,
        anchors: "_Anchors",
        settings: TripSettings,
        has_baseline: bool,
    ) -> DayPlan:
        start = anchors.start_of(day_number)
        end = anchors.end_of(day_number)
        start_index, end_index = start.index if start else None, end.index if end else None
        indices = [point_index[visit.id] for visit in visits]
        ordered_indices = optimize_path(
            indices, matrix.durations, start_index, end_index, time_budget_ms=search_budget_ms
        )
        by_index = {point_index[visit.id]: visit for visit in visits}
        ordered_visits = [by_index[index] for index in ordered_indices]
        for order, visit in enumerate(ordered_visits, start=1):
            visit.optimized_order = order

        optimized = calculate_metrics(
            ordered_indices, matrix.durations, matrix.distances, start_index, end_index
        )
        baseline = None
        baseline_order: list[str] = []
        if has_baseline and visits:
            original = sorted(
                visits,
                key=lambda visit: (
                    visit.original_order is None,
                    visit.original_order if visit.original_order is not None else visit.source_row,
                    visit.source_row,
                ),
            )
            baseline_indices = [point_index[visit.id] for visit in original]
            original_metrics = calculate_metrics(
                baseline_indices, matrix.durations, matrix.distances, start_index, end_index
            )
            baseline = RouteMetrics(
                distance_meters=original_metrics.distance_meters,
                duration_seconds=original_metrics.duration_seconds,
            )
            baseline_order = [visit.id for visit in original]

        polyline: list = []
        if ordered_visits:
            route_points = [GeoPoint(visit.id, visit.coordinate) for visit in ordered_visits]
            if start:
                route_points.insert(0, GeoPoint("__start__", start.coordinate))
            if end:
                route_points.append(GeoPoint("__end__", end.coordinate))
            polyline = await self._provider.ordered_route_polyline(route_points)
        stops = _schedule_stops(ordered_visits, ordered_indices, matrix, start_index, settings)
        estimated_legs = sum(1 for stop in stops if stop.travel_is_estimated)
        if end_index is not None and ordered_indices and matrix.is_estimated(ordered_indices[-1], end_index):
            estimated_legs += 1
        review_count = sum(1 for visit in visits if visit.geocode_status == "review")
        task_counts = [visit.task_count for visit in visits if visit.task_count is not None]
        return DayPlan(
            day_number=day_number,
            status=_day_status(bool(visits), estimated_legs, review_count),
            basis=_day_basis(bool(visits), estimated_legs, review_count),
            stops=stops,
            service_minutes_total=sum(stop.service_minutes for stop in stops),
            task_count_total=sum(task_counts) if task_counts else None,
            estimated_leg_count=estimated_legs,
            review_visit_count=review_count,
            optimized_metrics=RouteMetrics(
                distance_meters=optimized.distance_meters, duration_seconds=optimized.duration_seconds
            ),
            baseline_metrics=baseline,
            baseline_order=baseline_order,
            polyline=polyline,
            start=start.endpoint if start else None,
            end=end.endpoint if end else None,
        )

@dataclass(frozen=True)
class _Anchor:
    index: int
    coordinate: Coordinate
    endpoint: RouteEndpoint


@dataclass(frozen=True)
class _Anchors:
    """Where each day begins and ends.

    With lodging, a trip is a chain: the first day leaves from the start address and
    finishes at the hotel, middle days both start and end there, and the last day
    returns to the end address. Without lodging every day shares the same two anchors,
    which is the plain single-base case.
    """

    trip_days: int
    start: _Anchor | None = None
    end: _Anchor | None = None
    lodging: _Anchor | None = None

    @classmethod
    def build(
        cls,
        points: list[GeoPoint],
        settings: TripSettings,
        start_coordinate: Coordinate | None,
        end_coordinate: Coordinate | None,
        lodging_coordinate: Coordinate | None,
    ) -> "_Anchors":
        def add(coordinate: Coordinate | None, address: str | None, label: str, kind: str) -> _Anchor | None:
            if not coordinate or not address:
                return None
            index = len(points)
            points.append(GeoPoint(f"__{kind}__", coordinate))
            return _Anchor(
                index=index,
                coordinate=coordinate,
                endpoint=RouteEndpoint(label=label, address=address, coordinate=coordinate, kind=kind),
            )

        # Appended in a fixed order so an anchor's index does not depend on argument
        # evaluation order: start, then end, then lodging.
        start = add(start_coordinate, settings.start_address, "출발", "start")
        end = add(end_coordinate, settings.end_address, "종료", "end")
        # A one-day trip has no night in between, so lodging would only add a detour.
        lodging = (
            add(lodging_coordinate, settings.lodging_address, "숙소", "lodging")
            if settings.trip_days > 1
            else None
        )
        return cls(trip_days=settings.trip_days, start=start, end=end, lodging=lodging)

    def start_of(self, day_number: int) -> _Anchor | None:
        if self.lodging and day_number > 1:
            return self.lodging
        return self.start

    def end_of(self, day_number: int) -> _Anchor | None:
        if self.lodging and day_number < self.trip_days:
            return self.lodging
        return self.end

    def all_days(self) -> list[int]:
        return list(range(1, self.trip_days + 1))


def _required_legs(
    day_groups: dict[int, list[PlannedVisit]],
    point_index: dict[str, int],
    anchors: _Anchors,
) -> set[tuple[int, int]]:
    """Every leg a plan could traverse: within a day, plus that day's own anchors.

    Days never chain into one another, so cross-day pairs are left out. On a full
    trip that is the difference between a few hundred road lookups and tens of thousands.
    """
    legs: set[tuple[int, int]] = set()
    for day_number, day_visits in day_groups.items():
        indices = [point_index[visit.id] for visit in day_visits]
        if not indices:
            continue
        start = anchors.start_of(day_number)
        end = anchors.end_of(day_number)
        for origin in indices:
            for destination in indices:
                if origin != destination:
                    legs.add((origin, destination))
            if start is not None:
                legs.add((start.index, origin))
            if end is not None:
                legs.add((origin, end.index))
        if start is not None and end is not None:
            legs.add((start.index, end.index))
    return legs


def _time_hint_issues(visits: list[PlannedVisit]) -> list[PlanIssue]:
    """Say plainly which time notes were understood and which were only carried through."""
    issues: list[PlanIssue] = []
    exact = [visit for visit in visits if visit.time_constraint and visit.time_constraint.minute_of_day is not None]
    vague = [visit for visit in visits if visit.time_constraint and visit.time_constraint.minute_of_day is None]
    if exact:
        issues.append(
            PlanIssue(
                kind="time_constraint",
                severity="info",
                message=(
                    f"{len(exact)}곳의 시간 정보를 시각으로 인식했습니다. 방문 순서를 시간에 맞춰 강제하지는 않으며, "
                    "계산된 도착 시각이 조건을 벗어나면 결과에 표시합니다."
                ),
            )
        )
    if vague:
        issues.append(
            PlanIssue(
                kind="time_constraint",
                severity="info",
                message=(
                    f"{len(vague)}곳의 시간 정보는 정확한 시각이 아니어서 일정 계산에 사용하지 않고 "
                    "원본 표기 그대로 결과에 남겼습니다."
                ),
            )
        )
    return issues


def _time_violation_issues(days: list[DayPlan], visits: list[PlannedVisit]) -> list[PlanIssue]:
    row_of = {visit.id: visit.source_row for visit in visits}
    wording = {"late": "늦게 도착", "early": "이르게 도착", "shifted": "예정 시각과 차이가 큼"}
    issues: list[PlanIssue] = []
    for day in days:
        for stop in day.stops:
            if stop.time_status in wording and stop.time_constraint:
                issues.append(
                    PlanIssue(
                        kind="time_constraint",
                        severity="warning",
                        visit_id=stop.visit_id,
                        source_row=row_of.get(stop.visit_id),
                        message=(
                            f"{day.day_number}일차 {stop.optimized_order}번 방문지는 '{stop.time_constraint.description}' "
                            f"조건보다 {wording[stop.time_status]}합니다 (예상 도착 {stop.arrival_time})."
                        ),
                    )
                )
    return issues


def effective_service_minutes(visit: PlannedVisit, settings: TripSettings) -> int:
    """Minutes spent at one visit.

    An explicit per-visit figure always wins. Otherwise the default stay is extended by
    the user's own minutes-per-task rate, which stays at zero unless they set it: a task
    count on its own says nothing reliable about how long the work takes.
    """
    if visit.service_minutes is not None:
        return visit.service_minutes
    extra = settings.minutes_per_task * (visit.task_count or 0)
    return min(1_440, settings.default_service_minutes + extra)


def _visit_workload(visit: PlannedVisit, settings: TripSettings) -> float:
    """On-site burden in minutes, so a day of long visits is not packed like a day of short ones."""
    return float(max(effective_service_minutes(visit, settings), 1))


def _day_status(has_visits: bool, estimated_legs: int, review_count: int) -> str:
    if review_count:
        return "needs_review"
    if has_visits and estimated_legs:
        return "estimated"
    return "optimized"


def _day_basis(has_visits: bool, estimated_legs: int, review_count: int) -> str:
    if not has_visits:
        return "배정된 방문지가 없습니다."
    sentences = ["총 자동차 이동시간을 낮추는 순서로 계산했습니다."]
    if estimated_legs:
        sentences.append(f"이 중 {estimated_legs}개 구간은 도로 응답 대신 거리 기반 추정치입니다.")
    if review_count:
        sentences.append(f"{review_count}곳은 장소명으로 찾은 위치이므로 지도에서 확인이 필요합니다.")
    return " ".join(sentences)


def _capacity_issues(day: DayPlan) -> list[PlanIssue]:
    """Flag a day whose on-site time alone already fills a working day."""
    if not day.stops:
        return []
    on_site_hours = day.service_minutes_total / 60
    travel_hours = day.optimized_metrics.duration_seconds / 3_600
    if on_site_hours + travel_hours <= 9:
        return []
    return [
        PlanIssue(
            kind="capacity",
            severity="warning",
            message=(
                f"{day.day_number}일차는 방문 {len(day.stops)}곳 기준 체류 {round(on_site_hours, 1)}시간과 "
                f"이동 {round(travel_hours, 1)}시간으로 하루를 넘길 수 있습니다. 일정을 나누는 것을 검토해 주세요."
            ),
        )
    ]


def _geocode_issues(visits: list[PlannedVisit], key_configured: bool) -> list[PlanIssue]:
    issues: list[PlanIssue] = []
    if not key_configured:
        issues.append(
            PlanIssue(
                kind="settings",
                severity="error",
                message="서버에 Kakao REST API 키가 설정되지 않아 주소 좌표화를 실행하지 않았습니다.",
            )
        )
    for visit in visits:
        if visit.geocode_status == "unmatched":
            issues.append(
                PlanIssue(
                    kind="unmatched_address",
                    severity="error",
                    visit_id=visit.id,
                    source_row=visit.source_row,
                    message=f"원본 행 {visit.source_row}의 주소를 찾지 못했습니다. 주소를 수정한 뒤 다시 계산해 주세요.",
                )
            )
        elif visit.geocode_status == "review":
            issues.append(
                PlanIssue(
                    kind="review_address",
                    severity="warning",
                    visit_id=visit.id,
                    source_row=visit.source_row,
                    message=f"원본 행 {visit.source_row}은(는) 장소명 검색 결과입니다. 지도에서 위치를 확인해 주세요.",
                )
            )
    return issues


def _schedule_stops(
    visits: list[PlannedVisit],
    indices: list[int],
    matrix,
    start_index: int | None,
    settings: TripSettings,
) -> list[RouteStop]:
    hour, minute = (int(part) for part in settings.departure_time.split(":"))
    cursor = timedelta(hours=hour, minutes=minute)
    previous = start_index
    stops: list[RouteStop] = []
    for order, (visit, index) in enumerate(zip(visits, indices, strict=True), start=1):
        travel_seconds = matrix.durations[previous][index] if previous is not None else 0
        travel_distance = matrix.distances[previous][index] if previous is not None else 0
        travel_is_estimated = previous is not None and matrix.is_estimated(previous, index)
        travel_from_start = order == 1 and start_index is not None
        cursor += timedelta(seconds=travel_seconds)
        arrival = _format_time(cursor)
        time_status = check_arrival(visit.time_constraint, int(cursor.total_seconds() // 60))
        service_minutes = effective_service_minutes(visit, settings)
        cursor += timedelta(minutes=service_minutes)
        stops.append(
            RouteStop(
                visit_id=visit.id,
                optimized_order=order,
                label=visit.label,
                address=visit.normalized_address or visit.address,
                arrival_time=arrival,
                departure_time=_format_time(cursor),
                travel_seconds_from_previous=travel_seconds,
                travel_distance_meters_from_previous=travel_distance,
                travel_is_estimated=travel_is_estimated,
                travel_from_start=travel_from_start,
                service_minutes=service_minutes,
                task_count=visit.task_count,
                time_constraint=visit.time_constraint,
                time_status=time_status,
            )
        )
        previous = index
    return stops


def _format_time(value: timedelta) -> str:
    total_minutes = int(value.total_seconds() // 60)
    prefix = "" if total_minutes < 1_440 else f"+{total_minutes // 1_440}일 "
    return f"{prefix}{(total_minutes // 60) % 24:02}:{total_minutes % 60:02}"
