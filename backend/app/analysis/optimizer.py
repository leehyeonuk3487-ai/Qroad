from __future__ import annotations

from dataclasses import dataclass

try:
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
except ImportError:  # pragma: no cover - fallback is useful before optional dependency install
    pywrapcp = None
    routing_enums_pb2 = None


@dataclass(frozen=True)
class RouteMetrics:
    distance_meters: int
    duration_seconds: int


# A whole trip, not a single day, is what a caller waits on.
TOTAL_SEARCH_BUDGET_MS = 6_000
MIN_DAY_BUDGET_MS = 200
MAX_DAY_BUDGET_MS = 2_500


def day_search_budgets(stops_per_day: list[int]) -> list[int]:
    """Split one trip-wide search budget across its days, in proportion to their size."""
    total_stops = sum(stops_per_day)
    if not total_stops:
        return [MIN_DAY_BUDGET_MS for _ in stops_per_day]
    return [
        0
        if stops <= 1
        else max(MIN_DAY_BUDGET_MS, min(MAX_DAY_BUDGET_MS, round(TOTAL_SEARCH_BUDGET_MS * stops / total_stops)))
        for stops in stops_per_day
    ]


def optimize_path(
    visit_indices: list[int],
    durations: list[list[int]],
    start_index: int | None,
    end_index: int | None,
    time_budget_ms: int | None = None,
) -> list[int]:
    if len(visit_indices) < 2:
        return visit_indices
    if pywrapcp is None or routing_enums_pb2 is None:
        return _greedy_path(visit_indices, durations, start_index)

    local_nodes = list(visit_indices)
    start_local = len(local_nodes)
    local_nodes.append(start_index if start_index is not None else None)
    end_local = len(local_nodes)
    local_nodes.append(end_index if end_index is not None else None)

    def cost(from_node: int, to_node: int) -> int:
        left, right = local_nodes[from_node], local_nodes[to_node]
        if left is None or right is None:
            return 0
        return durations[left][right]

    manager = pywrapcp.RoutingIndexManager(len(local_nodes), 1, [start_local], [end_local])
    routing = pywrapcp.RoutingModel(manager)

    def transit(from_index: int, to_index: int) -> int:
        return cost(manager.IndexToNode(from_index), manager.IndexToNode(to_index))

    callback_index = routing.RegisterTransitCallback(transit)
    routing.SetArcCostEvaluatorOfAllVehicles(callback_index)
    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    # Guided local search always spends its whole budget, so scale it to the day's
    # size. A trip may hold 31 days, and a flat limit would stall the request.
    search.time_limit.FromMilliseconds(time_budget_ms or _search_budget_ms(len(visit_indices)))
    solution = routing.SolveWithParameters(search)
    if solution is None:
        return _greedy_path(visit_indices, durations, start_index)

    ordered: list[int] = []
    index = routing.Start(0)
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        if node < len(visit_indices):
            ordered.append(local_nodes[node])
        index = solution.Value(routing.NextVar(index))
    return ordered


def calculate_metrics(
    ordered_indices: list[int],
    durations: list[list[int]],
    distances: list[list[int]],
    start_index: int | None,
    end_index: int | None,
) -> RouteMetrics:
    if not ordered_indices:
        return RouteMetrics(0, 0)
    duration = 0
    distance = 0
    previous = start_index
    for current in ordered_indices:
        if previous is not None:
            duration += durations[previous][current]
            distance += distances[previous][current]
        previous = current
    if end_index is not None and previous is not None:
        duration += durations[previous][end_index]
        distance += distances[previous][end_index]
    return RouteMetrics(distance, duration)


def _search_budget_ms(stop_count: int) -> int:
    if stop_count <= 7:
        # Small days are solved to optimality by the first descent; polishing adds nothing.
        return MIN_DAY_BUDGET_MS
    return min(MAX_DAY_BUDGET_MS, 150 * stop_count)


def _greedy_path(visit_indices: list[int], durations: list[list[int]], start_index: int | None) -> list[int]:
    candidates = visit_indices if start_index is None else [start_index]
    best_route: list[int] | None = None
    best_cost: int | None = None
    for initial in candidates:
        remaining = set(visit_indices)
        route: list[int] = []
        previous = initial
        if start_index is None:
            route.append(initial)
            remaining.remove(initial)
        while remaining:
            next_visit = min(remaining, key=lambda item: durations[previous][item])
            route.append(next_visit)
            remaining.remove(next_visit)
            previous = next_visit
        cost = sum(durations[left][right] for left, right in zip(route, route[1:]))
        if start_index is not None:
            cost += durations[start_index][route[0]]
        if best_cost is None or cost < best_cost:
            best_route, best_cost = route, cost
    return best_route or visit_indices
