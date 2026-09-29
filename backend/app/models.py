from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# One request stays small enough to geocode and route inside a single HTTP call.
MAX_VISITS = 200


class Coordinate(BaseModel):
    longitude: float = Field(ge=124, le=132)
    latitude: float = Field(ge=33, le=39.5)


class VisitRequest(BaseModel):
    """The deliberately small, canonical payload accepted from the browser."""

    id: str = Field(min_length=1, max_length=80)
    source_row: int = Field(ge=1, le=1_000_000)
    label: str = Field(min_length=1, max_length=160)
    address: str = Field(min_length=2, max_length=400)
    original_day: int | None = Field(default=None, ge=1, le=365)
    original_order: int | None = Field(default=None, ge=1, le=100_000)
    service_minutes: int | None = Field(default=None, ge=0, le=1_440)
    task_count: int | None = Field(default=None, ge=0, le=10_000)
    time_hint: str | None = Field(default=None, max_length=60)

    @field_validator("label", "address")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return " ".join(value.split())


class TripSettings(BaseModel):
    trip_days: int = Field(ge=1, le=31)
    start_address: str | None = Field(default=None, max_length=400)
    end_address: str | None = Field(default=None, max_length=400)
    lodging_address: str | None = Field(default=None, max_length=400)
    departure_time: str = Field(default="09:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    default_service_minutes: int = Field(default=30, ge=0, le=480)
    # Off by default: a task count alone does not reveal how long the work takes, so the
    # conversion rate is the user's to state rather than the service's to assume.
    minutes_per_task: int = Field(default=0, ge=0, le=240)

    @field_validator("start_address", "end_address", "lodging_address", mode="before")
    @classmethod
    def empty_string_to_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None


class PlanningRequest(BaseModel):
    visits: list[VisitRequest] = Field(min_length=1, max_length=MAX_VISITS)
    settings: TripSettings

    @field_validator("visits")
    @classmethod
    def unique_visit_ids(cls, visits: list[VisitRequest]) -> list[VisitRequest]:
        if len({visit.id for visit in visits}) != len(visits):
            raise ValueError("Each visit id must be unique.")
        return visits


class TimeConstraint(BaseModel):
    """A time note, sorted into one that can be checked and one that cannot.

    ``at``/``before``/``after`` carry a real minute of day. ``vague`` keeps the wording
    for display but never drives a calculation, so a loose note is never presented as
    though the schedule honoured it.
    """

    kind: Literal["at", "before", "after", "vague"]
    minute_of_day: int | None = Field(default=None, ge=0, le=1_439)
    raw: str
    description: str


class GeocodeCandidate(BaseModel):
    label: str
    address: str
    coordinate: Coordinate
    source: Literal["address", "keyword"]


class PlannedVisit(BaseModel):
    id: str
    source_row: int
    label: str
    address: str
    normalized_address: str | None = None
    coordinate: Coordinate | None = None
    geocode_status: Literal["matched", "review", "unmatched"]
    geocode_candidates: list[GeocodeCandidate] = Field(default_factory=list)
    original_day: int | None = None
    original_order: int | None = None
    optimized_day: int | None = None
    optimized_order: int | None = None
    service_minutes: int | None = None
    task_count: int | None = None
    time_hint: str | None = None
    time_constraint: TimeConstraint | None = None


class RouteStop(BaseModel):
    visit_id: str
    optimized_order: int
    label: str
    address: str
    arrival_time: str | None = None
    departure_time: str | None = None
    travel_seconds_from_previous: int = 0
    travel_distance_meters_from_previous: int = 0
    travel_is_estimated: bool = False
    travel_from_start: bool = False
    service_minutes: int = 0
    task_count: int | None = None
    time_constraint: TimeConstraint | None = None
    time_status: Literal["ok", "late", "early", "shifted"] | None = None


class RouteMetrics(BaseModel):
    distance_meters: int = 0
    duration_seconds: int = 0


class RouteEndpoint(BaseModel):
    label: str
    address: str
    coordinate: Coordinate
    kind: Literal["start", "end", "lodging"] = "start"


class DayPlan(BaseModel):
    day_number: int
    status: Literal["optimized", "estimated", "needs_review"]
    basis: str
    stops: list[RouteStop] = Field(default_factory=list)
    optimized_metrics: RouteMetrics
    baseline_metrics: RouteMetrics | None = None
    polyline: list[Coordinate] = Field(default_factory=list)
    start: RouteEndpoint | None = None
    end: RouteEndpoint | None = None
    baseline_order: list[str] = Field(default_factory=list)
    service_minutes_total: int = 0
    task_count_total: int | None = None
    estimated_leg_count: int = 0
    review_visit_count: int = 0


class PlanIssue(BaseModel):
    kind: Literal[
        "unmatched_address",
        "review_address",
        "routing_fallback",
        "settings",
        "capacity",
        "time_constraint",
    ]
    severity: Literal["info", "warning", "error"]
    visit_id: str | None = None
    source_row: int | None = None
    message: str


class PlanningResponse(BaseModel):
    visits: list[PlannedVisit]
    days: list[DayPlan]
    issues: list[PlanIssue]
    matrix_source: Literal["kakao_road", "estimated"]
    partition_basis: str
    optimization_status: Literal["completed", "partial"]
