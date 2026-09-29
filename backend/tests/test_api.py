from fastapi.testclient import TestClient

from app.main import app
from app.models import MAX_VISITS

client = TestClient(app)


def test_health_reports_key_state_and_request_ceiling() -> None:
    body = client.get("/api/health").json()

    assert body["ok"] is True
    assert body["max_visits"] == MAX_VISITS
    assert "kakao_rest_api_key" not in body, "the key itself must never leave the server"


def test_too_many_visits_returns_one_readable_sentence() -> None:
    payload = {
        "settings": {"trip_days": 2},
        "visits": [
            {"id": f"row-{index}", "source_row": index + 2, "label": "L", "address": "서울특별시 중구 세종대로 110"}
            for index in range(MAX_VISITS + 1)
        ],
    }

    response = client.post("/api/plan", json=payload)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, str), "a list body renders as [object Object] in the browser"
    assert str(MAX_VISITS) in detail


def test_invalid_settings_are_explained_without_echoing_the_address() -> None:
    payload = {
        "settings": {"trip_days": 99, "departure_time": "25:00"},
        "visits": [{"id": "row-2", "source_row": 2, "label": "L", "address": "서울특별시 중구 세종대로 110"}],
    }

    response = client.post("/api/plan", json=payload)

    assert response.status_code == 422
    assert "세종대로" not in response.text


def test_plan_without_a_key_reports_the_gap_instead_of_inventing_coordinates() -> None:
    payload = {
        "settings": {"trip_days": 1},
        "visits": [{"id": "row-2", "source_row": 2, "label": "L", "address": "서울특별시 중구 세종대로 110"}],
    }

    body = client.post("/api/plan", json=payload).json()

    assert body["visits"][0]["coordinate"] is None
    assert body["visits"][0]["geocode_status"] == "unmatched"
    assert body["optimization_status"] == "partial"
    assert any(issue["kind"] == "unmatched_address" for issue in body["issues"])
