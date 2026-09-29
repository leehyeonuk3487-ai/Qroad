from __future__ import annotations

import math
from typing import Callable

from app.models import Coordinate, PlannedVisit

# How far a day may run past the average before it stops accepting nearby visits.
CAPACITY_SLACK = 1.3


def assign_days(
    visits: list[PlannedVisit],
    trip_days: int,
    weights: dict[str, float] | None = None,
) -> tuple[dict[str, int], list[str]]:
    """Keep valid supplied days fixed; assign the remainder by proximity and workload balance.

    ``weights`` carries each visit's on-site workload. Without it every visit counts
    as one unit, which keeps the balance identical to a plain visit count.
    """
    weight_of = _weight_lookup(weights)
    assignments: dict[str, int] = {}
    warnings: list[str] = []
    valid_visits = [visit for visit in visits if visit.coordinate]
    groups: dict[int, list[PlannedVisit]] = {day: [] for day in range(1, trip_days + 1)}
    pending: list[PlannedVisit] = []

    for visit in valid_visits:
        if visit.original_day is None:
            pending.append(visit)
        elif visit.original_day <= trip_days:
            assignments[visit.id] = visit.original_day
            groups[visit.original_day].append(visit)
        else:
            pending.append(visit)
            warnings.append(f"원본 일차가 출장 기간을 벗어난 행 {visit.source_row}은(는) 다시 배정했습니다.")

    if not pending:
        return assignments, warnings

    # With no supplied days, spread geographically distant seeds across days first.
    empty_days = [day for day, members in groups.items() if not members]
    for day, seed in zip(empty_days, _farthest_seeds(pending, len(empty_days)), strict=False):
        assignments[seed.id] = day
        groups[day].append(seed)

    assigned_ids = set(assignments)
    remaining = [visit for visit in pending if visit.id not in assigned_ids]
    target_load = max(1.0, sum(weight_of(visit) for visit in valid_visits) / trip_days)
    capacity = target_load * CAPACITY_SLACK
    loads = {day: sum(weight_of(member) for member in members) for day, members in groups.items()}

    for visit in sorted(remaining, key=lambda item: (item.coordinate.latitude, item.coordinate.longitude, item.source_row)):
        weight = weight_of(visit)
        # Proximity decides among the days that still have room. Without the ceiling a
        # dense cluster pulls in everything nearby and one day ends up twice as long as the rest.
        roomy = [day for day in groups if loads[day] + weight <= capacity]
        if roomy:
            day = min(roomy, key=lambda candidate: _assignment_score(visit, groups[candidate], target_load, weight_of))
        else:
            day = min(groups, key=lambda candidate: (loads[candidate], candidate))
        assignments[visit.id] = day
        groups[day].append(visit)
        loads[day] += weight

    return assignments, warnings


def _weight_lookup(weights: dict[str, float] | None) -> Callable[[PlannedVisit], float]:
    if not weights:
        return lambda visit: 1.0
    return lambda visit: max(0.0, weights.get(visit.id, 1.0))


def _farthest_seeds(visits: list[PlannedVisit], count: int) -> list[PlannedVisit]:
    if count <= 0:
        return []
    ordered = sorted(visits, key=lambda item: (item.coordinate.latitude, item.coordinate.longitude, item.source_row))
    seeds = [ordered[0]]
    chosen = {ordered[0].id}
    while len(seeds) < min(count, len(ordered)):
        candidate = max(
            (visit for visit in ordered if visit.id not in chosen),
            key=lambda visit: min(_geo_distance(visit.coordinate, seed.coordinate) for seed in seeds),
        )
        seeds.append(candidate)
        chosen.add(candidate.id)
    return seeds


def _assignment_score(
    visit: PlannedVisit,
    members: list[PlannedVisit],
    target_load: float,
    weight_of: Callable[[PlannedVisit], float],
) -> float:
    if not members:
        return -1.0
    centroid_latitude = sum(member.coordinate.latitude for member in members) / len(members)
    centroid_longitude = sum(member.coordinate.longitude for member in members) / len(members)
    geographic_distance = math.hypot(
        visit.coordinate.latitude - centroid_latitude,
        visit.coordinate.longitude - centroid_longitude,
    )
    # A soft workload penalty avoids a day being geographically neat but impractically full.
    projected_load = sum(weight_of(member) for member in members) + weight_of(visit)
    workload_penalty = max(0.0, projected_load - target_load) / target_load * 0.08
    return geographic_distance + workload_penalty


def _geo_distance(left: Coordinate, right: Coordinate) -> float:
    return math.hypot(left.latitude - right.latitude, left.longitude - right.longitude)
