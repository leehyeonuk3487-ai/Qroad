from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.models import MAX_VISITS, PlanningRequest, PlanningResponse
from app.providers.kakao import KakaoProvider
from app.services.planner import TripPlanner

logging.getLogger("httpx").setLevel(logging.WARNING)

settings = get_settings()
app = FastAPI(title="Qroad API", version="0.1.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def handle_invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Answer with one readable sentence.

    The default body is a list of error objects that a browser can only render as
    "[object Object]", and it echoes the submitted values back out of the server.
    """
    return JSONResponse(status_code=422, content={"detail": _validation_message(exc)})


def _validation_message(exc: RequestValidationError) -> str:
    locations = {tuple(error.get("loc", ())) for error in exc.errors()}
    if any("visits" in location for location in locations):
        return (
            f"방문지 목록을 확인해 주세요. 한 번에 1개 이상 {MAX_VISITS}개 이하만 계산할 수 있으며, "
            "주소는 2자 이상이어야 합니다."
        )
    if any("settings" in location for location in locations):
        return "출장 조건을 확인해 주세요. 출장일수는 1~31일, 출발 시각은 HH:MM 형식이어야 합니다."
    return "요청 형식을 확인해 주세요."


@app.get("/api/health")
async def health() -> dict[str, bool | int]:
    return {
        "ok": True,
        "kakao_rest_key_configured": bool(settings.kakao_rest_api_key),
        "max_visits": MAX_VISITS,
    }


@app.post("/api/plan", response_model=PlanningResponse)
async def plan_trip(request: PlanningRequest) -> PlanningResponse:
    try:
        return await TripPlanner(KakaoProvider(settings.kakao_rest_api_key)).plan(request)
    except Exception as exc:
        # Do not serialize incoming visit details, provider responses, or secrets to a client or log.
        logging.getLogger(__name__).exception("Trip planning failed without recording trip payload")
        raise HTTPException(status_code=500, detail="경로 계산 중 오류가 발생했습니다. 주소와 설정을 확인한 뒤 다시 시도해 주세요.") from exc
