import pytest

from app.models import Coordinate
from app.providers.kakao import GeoPoint, KakaoProvider


def points(count: int) -> list[GeoPoint]:
    return [
        GeoPoint(f"p{index}", Coordinate(latitude=37.5 + index * 0.01, longitude=127.0 + index * 0.01))
        for index in range(count)
    ]


@pytest.mark.asyncio
async def test_without_a_key_every_required_leg_is_marked_estimated() -> None:
    provider = KakaoProvider(None)
    required = {(0, 1), (1, 0), (0, 2)}

    matrix = await provider.build_road_matrix(points(3), required)

    assert matrix.source == "estimated"
    assert matrix.estimated_pairs == required
    assert matrix.estimated_edges == 3
    assert matrix.is_estimated(0, 1) is True
    assert matrix.is_estimated(1, 1) is False  # a stop never travels to itself


@pytest.mark.asyncio
async def test_only_required_legs_are_requested_and_unanswered_ones_stay_estimated(monkeypatch) -> None:
    provider = KakaoProvider("test-key")
    asked: list[tuple[str, tuple[int, ...]]] = []

    async def fake_multi_destinations(origin, destinations, destination_indices):
        asked.append((origin.id, tuple(destination_indices)))
        # The road API answers for the first destination only; Kakao drops the rest
        # when they fall outside the request radius.
        return [(destination_indices[0], 640, 5_400)]

    monkeypatch.setattr(provider, "_multi_destinations", fake_multi_destinations)
    required = {(0, 1), (0, 2)}

    matrix = await provider.build_road_matrix(points(4), required)

    assert asked == [("p0", (1, 2))], "one batched call, and nothing for unused origins"
    assert matrix.source == "kakao_road"
    assert matrix.durations[0][1] == 640
    assert matrix.distances[0][1] == 5_400
    assert matrix.is_estimated(0, 1) is False
    assert matrix.is_estimated(0, 2) is True
    assert matrix.estimated_pairs == {(0, 2)}


@pytest.mark.asyncio
async def test_a_road_backed_matrix_reports_unrequested_legs_as_estimated() -> None:
    # Legs outside the required set were never priced, so nothing may claim they are road times.
    provider = KakaoProvider(None)
    matrix = await provider.build_road_matrix(points(3), {(0, 1)})

    assert matrix.is_estimated(2, 0) is True
