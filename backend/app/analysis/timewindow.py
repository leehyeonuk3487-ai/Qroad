from __future__ import annotations

import re

from app.models import TimeConstraint

# "09:00", "9시 30분", "오전 10시", "13시"
_CLOCK = re.compile(r"(?:(오전|오후|아침|저녁|밤)\s*)?(\d{1,2})\s*(?::|시)\s*(\d{1,2})?\s*분?")
_BEFORE = ("까지", "이전", "전까지", "안에", "이내")
_AFTER = ("이후", "부터", "지나서", "넘어서")
_VAGUE = {
    "오전": "오전",
    "am": "오전",
    "오후": "오후",
    "pm": "오후",
    "아침": "오전",
    "점심": "점심 전후",
    "정오": "점심 전후",
    "저녁": "저녁",
    "밤": "저녁",
    "종일": "종일",
    "무관": "시간 무관",
}


def parse_time_hint(raw: str | None) -> TimeConstraint | None:
    """Sort a free-text time note into something the schedule can actually check.

    A sheet may say "13:00까지", or just "오후". Only the first kind can be verified
    against a computed arrival, so the two are kept apart rather than averaged into a
    guess: an exact note becomes a minute-of-day bound, a loose one stays descriptive.
    """
    if not raw:
        return None
    text = " ".join(raw.split())
    if not text:
        return None

    minutes = _clock_minutes(text)
    if minutes is not None:
        kind = "before" if any(marker in text for marker in _BEFORE) else "after" if any(
            marker in text for marker in _AFTER
        ) else "at"
        return TimeConstraint(kind=kind, minute_of_day=minutes, raw=text, description=_describe(kind, minutes))

    lowered = text.lower()
    for marker, description in _VAGUE.items():
        if marker in lowered:
            return TimeConstraint(kind="vague", minute_of_day=None, raw=text, description=description)
    return TimeConstraint(kind="vague", minute_of_day=None, raw=text, description="형식을 알 수 없음")


def _clock_minutes(text: str) -> int | None:
    match = _CLOCK.search(text)
    if not match:
        return None
    meridiem, hour_text, minute_text = match.groups()
    hour = int(hour_text)
    minute = int(minute_text) if minute_text else 0
    if hour > 23 or minute > 59:
        return None
    if meridiem in ("오후", "저녁", "밤") and hour < 12:
        hour += 12
    if meridiem in ("오전", "아침") and hour == 12:
        hour = 0
    return hour * 60 + minute


def _describe(kind: str, minutes: int) -> str:
    clock = f"{minutes // 60:02}:{minutes % 60:02}"
    if kind == "before":
        return f"{clock}까지 도착"
    if kind == "after":
        return f"{clock} 이후 방문"
    return f"{clock} 방문 예정"


def check_arrival(constraint: TimeConstraint | None, arrival_minutes: int) -> str | None:
    """Compare a planned arrival against an exact note. Loose notes are never judged."""
    if constraint is None or constraint.minute_of_day is None:
        return None
    if constraint.kind == "before" and arrival_minutes > constraint.minute_of_day:
        return "late"
    if constraint.kind == "after" and arrival_minutes < constraint.minute_of_day:
        return "early"
    if constraint.kind == "at" and abs(arrival_minutes - constraint.minute_of_day) > 60:
        return "shifted"
    return "ok"
