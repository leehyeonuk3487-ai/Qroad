from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

import httpx

from app.models import Coordinate, GeocodeCandidate, PlannedVisit, VisitRequest


KAKAO_LOCAL_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json"
KAKAO_LOCAL_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_DESTINATIONS_URL = "https://apis-navi.kakaomobility.com/v1/destinations/directions"
KAKAO_WAYPOINTS_URL = "https://apis-navi.kakaomobility.com/v1/waypoints/directions"

# Checked against developers.kakaomobility.com rather than assumed, because exceeding a
# documented ceiling fails the whole call rather than returning fewer results:
#   - 다중 목적지: at most 30 destinations per request.
#   - radius: required, in metres, documented maximum 10,000.
#   - 다중 경유지: at most 30 intermediate waypoints, so 32 points including both ends.
DESTINATION_BATCH_SIZE = 30
DESTINATION_RADIUS_METERS = 10_000
MAX_ROUTE_POINTS = 32


@dataclass(frozen=True)
class GeoPoint:
    id: str
    coordinate: Coordinate


@dataclass
class RoadMatrix:
    durations: list[list[int]]
    distances: list[list[int]]
    source: str
    estimated_edges: int
    estimated_pairs: set[tuple[int, int]] = field(default_factory=set)

    def is_estimated(self, origin: int, destination: int) -> bool:
        """True when this single leg fell back to a straight-line estimate."""
        if origin == destination:
            return False
        if self.source != "kakao_road":
            return True
        return (origin, destination) in self.estimated_pairs


class KakaoProvider:
    """Kakao calls, isolated so request bodies never enter application logs."""

    def __init__(self, rest_api_key: str | None) -> None:
        self._key = rest_api_key

    @property
    def enabled(self) -> bool:
        return bool(self._key)

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"KakaoAK {self._key}"} if self._key else {}

    async def geocode_visit(self, visit: VisitRequest) -> PlannedVisit:
        result = PlannedVisit(
            id=visit.id,
            source_row=visit.source_row,
            label=visit.label,
            address=visit.address,
            original_day=visit.original_day,
            original_order=visit.original_order,
            service_minutes=visit.service_minutes,
            task_count=visit.task_count,
            time_hint=visit.time_hint,
            geocode_status="unmatched",
        )
        match, candidates = await self.geocode(visit.address, visit.label)
        result.geocode_candidates = candidates
        if match is None:
            return result
        result.coordinate = match.coordinate
        result.normalized_address = match.address
        result.geocode_status = "matched" if match.source == "address" else "review"
        return result

    async def geocode_endpoint(self, address: str | None) -> Coordinate | None:
        if not address:
            return None
        match, _ = await self.geocode(address, "")
        return match.coordinate if match else None

    async def geocode(
        self, address: str, label: str
    ) -> tuple[GeocodeCandidate | None, list[GeocodeCandidate]]:
        if not self.enabled:
            return None, []

        async with httpx.AsyncClient(timeout=12.0) as client:
            address_docs = await self._get_documents(client, KAKAO_LOCAL_ADDRESS_URL, {"query": address})
            address_candidates = self._to_candidates(address_docs, "address")
            if address_candidates:
                return address_candidates[0], address_candidates[:5]

            # A keyword lookup is only a fallback: the UI labels its first result for review.
            query = " ".join(part for part in (label, address) if part)
            keyword_docs = await self._get_documents(client, KAKAO_LOCAL_KEYWORD_URL, {"query": query})
            keyword_candidates = self._to_candidates(keyword_docs, "keyword")
            return (keyword_candidates[0] if keyword_candidates else None), keyword_candidates[:5]

    async def _get_documents(
        self, client: httpx.AsyncClient, url: str, params: dict[str, str]
    ) -> list[dict]:
        try:
            response = await client.get(url, headers=self._headers, params=params)
            response.raise_for_status()
            data = response.json()
            return data.get("documents", []) if isinstance(data, dict) else []
        except (httpx.HTTPError, ValueError):
            # Sensitive query and response data are intentionally not logged.
            return []

    @staticmethod
    def _to_candidates(documents: Iterable[dict], source: str) -> list[GeocodeCandidate]:
        candidates: list[GeocodeCandidate] = []
        for document in documents:
            try:
                if source == "keyword":
                    label = str(document.get("place_name") or document.get("address_name") or "검색 결과")
                    address = str(
                        document.get("road_address_name") or document.get("address_name") or ""
                    )
                else:
                    label = str(document.get("address_name") or "주소 검색 결과")
                    address = str(
                        (document.get("road_address") or {}).get("address_name")
                        or document.get("address_name")
                        or ""
                    )
                candidates.append(
                    GeocodeCandidate(
                        label=label,
                        address=address,
                        coordinate=Coordinate(
                            longitude=float(document["x"]), latitude=float(document["y"])
                        ),
                        source=source,
                    )
                )
            except (KeyError, TypeError, ValueError):
                continue
        return candidates

    async def build_road_matrix(
        self, points: list[GeoPoint], required_pairs: set[tuple[int, int]] | None = None
    ) -> RoadMatrix:
        """Road times for the legs the plan needs.

        Callers pass the legs a plan can actually traverse. Requesting the full
        square would spend thousands of calls on cross-day pairs no route uses.
        """
        count = len(points)
        durations, distances = _estimated_matrices(points)
        required = (
            {(origin, destination) for origin, destination in required_pairs if origin != destination}
            if required_pairs is not None
            else {(origin, destination) for origin in range(count) for destination in range(count) if origin != destination}
        )
        if count <= 1 or not self.enabled or not required:
            return RoadMatrix(durations, distances, "estimated", len(required), set(required))

        by_origin: dict[int, list[int]] = defaultdict(list)
        for origin, destination in sorted(required):
            by_origin[origin].append(destination)

        semaphore = asyncio.Semaphore(4)

        async def route_batch(origin_index: int, destination_indices: list[int]) -> list[tuple[int, int, int]]:
            async with semaphore:
                return await self._multi_destinations(
                    points[origin_index],
                    [points[index] for index in destination_indices],
                    destination_indices,
                )

        batches: list[tuple[int, asyncio.Task[list[tuple[int, int, int]]]]] = []
        for origin_index, destination_indices in by_origin.items():
            for start in range(0, len(destination_indices), DESTINATION_BATCH_SIZE):
                chunk = destination_indices[start : start + DESTINATION_BATCH_SIZE]
                batches.append((origin_index, asyncio.create_task(route_batch(origin_index, chunk))))

        estimated_pairs = set(required)
        for origin_index, task in batches:
            for destination_index, duration, distance in await task:
                if (origin_index, destination_index) not in required:
                    continue
                durations[origin_index][destination_index] = duration
                distances[origin_index][destination_index] = distance
                estimated_pairs.discard((origin_index, destination_index))

        resolved = len(required) - len(estimated_pairs)
        return RoadMatrix(
            durations,
            distances,
            "kakao_road" if resolved else "estimated",
            len(estimated_pairs),
            estimated_pairs,
        )

    async def _multi_destinations(
        self, origin: GeoPoint, destinations: list[GeoPoint], destination_indices: list[int]
    ) -> list[tuple[int, int, int]]:
        payload = {
            "origin": {"x": origin.coordinate.longitude, "y": origin.coordinate.latitude},
            "destinations": [
                {
                    "key": str(index),
                    "x": point.coordinate.longitude,
                    "y": point.coordinate.latitude,
                }
                for point, index in zip(destinations, destination_indices, strict=True)
            ],
            "radius": DESTINATION_RADIUS_METERS,
            "priority": "TIME",
        }
        try:
            async with httpx.AsyncClient(timeout=18.0) as client:
                response = await client.post(KAKAO_DESTINATIONS_URL, headers=self._headers, json=payload)
                response.raise_for_status()
                data = response.json()
            routes = data.get("routes", []) if isinstance(data, dict) else []
            results: list[tuple[int, int, int]] = []
            for route in routes:
                if route.get("result_code") != 0 or not route.get("summary"):
                    continue
                summary = route["summary"]
                results.append((int(route["key"]), int(summary["duration"]), int(summary["distance"])))
            return results
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return []

    async def ordered_route_polyline(self, points: list[GeoPoint]) -> list[Coordinate]:
        """Fetch road vertices for the final sequence; omitted when API limits are exceeded."""
        if not self.enabled or len(points) < 2 or len(points) > MAX_ROUTE_POINTS:
            return []
        payload = {
            "origin": {"x": points[0].coordinate.longitude, "y": points[0].coordinate.latitude},
            "destination": {"x": points[-1].coordinate.longitude, "y": points[-1].coordinate.latitude},
            "waypoints": [
                {"name": point.id, "x": point.coordinate.longitude, "y": point.coordinate.latitude}
                for point in points[1:-1]
            ],
            "priority": "TIME",
            "car_fuel": "GASOLINE",
            "car_hipass": False,
            "alternatives": False,
            "road_details": False,
            "summary": False,
        }
        try:
            async with httpx.AsyncClient(timeout=25.0) as client:
                response = await client.post(KAKAO_WAYPOINTS_URL, headers=self._headers, json=payload)
                response.raise_for_status()
                data = response.json()
            route = (data.get("routes") or [None])[0]
            if not route or route.get("result_code") != 0:
                return []
            vertices: list[Coordinate] = []
            for section in route.get("sections", []):
                for road in section.get("roads", []):
                    raw_vertices = road.get("vertexes", [])
                    vertices.extend(
                        Coordinate(longitude=float(raw_vertices[i]), latitude=float(raw_vertices[i + 1]))
                        for i in range(0, len(raw_vertices) - 1, 2)
                    )
            return vertices
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return []


def _estimated_matrices(points: list[GeoPoint]) -> tuple[list[list[int]], list[list[int]]]:
    durations: list[list[int]] = []
    distances: list[list[int]] = []
    for origin in points:
        duration_row: list[int] = []
        distance_row: list[int] = []
        for destination in points:
            straight_meters = _haversine_meters(origin.coordinate, destination.coordinate)
            road_meters = 0 if straight_meters == 0 else max(250, round(straight_meters * 1.3))
            distance_row.append(road_meters)
            duration_row.append(0 if road_meters == 0 else max(60, round(road_meters / 11.1)))
        durations.append(duration_row)
        distances.append(distance_row)
    return durations, distances


def _haversine_meters(left: Coordinate, right: Coordinate) -> float:
    radius = 6_371_000
    latitude_delta = math.radians(right.latitude - left.latitude)
    longitude_delta = math.radians(right.longitude - left.longitude)
    a = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(left.latitude))
        * math.cos(math.radians(right.latitude))
        * math.sin(longitude_delta / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
