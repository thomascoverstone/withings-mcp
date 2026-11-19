#!/usr/bin/env python3
"""
Withings MCP server.

Exposes the user's Withings data (weight, body composition, segmental analysis,
vascular age, pulse wave velocity, nerve health score, heart rate, ECG
recordings, linked devices) to Claude over the MCP stdio transport.

Run the one-time login first (with the project's virtual environment active):
    python withings_auth.py
Then register this file as a stdio MCP server (see README.md).
"""
from __future__ import annotations

import json
import logging
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer  # mcp SDK 2.x (was FastMCP in 1.x)
from mcp.types import ToolAnnotations
from pydantic import Field

import withings_client as wc

# stdout is the MCP transport; all diagnostics go to stderr.
logging.basicConfig(
    level=logging.INFO, stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("withings.server")

mcp = MCPServer(
    "withings_mcp",
    instructions=(
        "Live, read-only access to the user's Withings account: weigh-ins and body "
        "composition from Withings scales, ECG recordings and linked devices. "
        "Masses come back in kg with an lb conversion, fat_ratio is a percent, "
        "and times are ISO-8601 in the user's Withings timezone. "
        "Use withings_get_latest_body_scan for 'what did I weigh today' questions, "
        "withings_get_weight_trend for how things are changing, and "
        "withings_get_measurements for raw history between dates. "
        "If a tool answers with an error saying no login is saved, tell the user "
        "to run withings_auth.py in a terminal and then try again."
    ),
)

_client = wc.WithingsClient()

READ_ONLY = ToolAnnotations(
    read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True,
)

TREND_METRICS = [
    "weight", "fat_ratio", "fat_mass", "muscle_mass", "bone_mass", "hydration",
    "visceral_fat_index", "basal_metabolic_rate", "vascular_age",
    "pulse_wave_velocity", "heart_rate", "nerve_health_score_feet", "metabolic_age",
]

AFIB = {0: "negative", 1: "positive", 2: "inconclusive"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _dump(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, default=str)


def _error(exc: Exception) -> str:
    log.warning("tool error: %s", exc)
    return _dump({"error": str(exc)})


def _parse_day(value: str | None, *, default: datetime, end_of_day: bool = False) -> datetime:
    """Parse 'YYYY-MM-DD' (or a full ISO timestamp) into an aware datetime."""
    if not value:
        return default
    text = value.strip()
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise wc.WithingsError(f"Bad date {value!r}; use YYYY-MM-DD.") from exc
    if dt.tzinfo is None:
        dt = dt.astimezone()  # naive -> this machine's local zone
    if end_of_day and len(text) <= 10:
        dt = dt + timedelta(days=1)  # make a bare end date inclusive
    return dt


def _stat_block(points: list[tuple[str, int, float]], unit: str, now_epoch: float) -> dict[str, Any]:
    """points = [(iso time, epoch, value)] oldest first."""
    values = [v for _, _, v in points]
    block: dict[str, Any] = {
        "unit": unit,
        "n": len(values),
        "first": {"time": points[0][0], "value": values[0]},
        "last": {"time": points[-1][0], "value": values[-1]},
        "change": round(values[-1] - values[0], 3),
        "min": min(values),
        "max": max(values),
        "mean": round(statistics.fmean(values), 3),
    }
    week = 7 * 86400
    recent = [v for _, e, v in points if e >= now_epoch - week]
    previous = [v for _, e, v in points if now_epoch - 2 * week <= e < now_epoch - week]
    if recent and previous:
        block["last_7d_avg"] = round(statistics.fmean(recent), 3)
        block["previous_7d_avg"] = round(statistics.fmean(previous), 3)
        block["week_over_week_change"] = round(block["last_7d_avg"] - block["previous_7d_avg"], 3)
    if unit == "kg":
        block["change_lb"] = round(block["change"] * wc.KG_TO_LB, 2)
        block["last_lb"] = round(values[-1] * wc.KG_TO_LB, 2)
    return block


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------

@mcp.tool(name="withings_get_latest_body_scan", annotations=READ_ONLY)
async def withings_get_latest_body_scan(
    count: Annotated[int, Field(
        ge=1, le=20,
        description="How many of the most recent weigh-in sessions to return (default 1).",
    )] = 1,
) -> str:
    """
    Return the most recent weigh-in(s) from the user's Withings scale with every
    metric that was captured: weight, fat_ratio, fat_mass, fat_free_mass,
    muscle_mass, bone_mass, hydration (total body water), extracellular /
    intracellular water, visceral_fat_index, basal_metabolic_rate, metabolic_age,
    heart_rate, pulse_wave_velocity, vascular_age, nerve_health_score_*,
    electrodermal_activity_*, and segmental fat / muscle masses per limb and torso.

    Groups of readings taken within 10 minutes of each other are merged into one
    "session". Masses are kg with an "lb" field; times are in the user's Withings
    timezone. Searches the last 90 days first, then the last 2 years.

    Returns JSON: {"timezone": str, "returned": int, "sessions": [ {time, epoch,
    device_model, sources, metrics: {name: {value, unit, lb?}}} ]}.
    """
    try:
        now = datetime.now(timezone.utc)
        sessions: list[dict[str, Any]] = []
        tz = ""
        for days in (90, 730):
            groups, tz = await _client.measure_groups(start=now - timedelta(days=days), end=now)
            sessions = wc.build_sessions(groups, tz)
            if sessions:
                break
        if not sessions:
            return _dump({
                "timezone": tz, "returned": 0, "sessions": [],
                "note": "No measurements were found in the last 2 years.",
            })
        return _dump({
            "timezone": tz,
            "returned": min(count, len(sessions)),
            "sessions": sessions[:count],
        })
    except Exception as exc:  # noqa: BLE001 - surface everything to the model
        return _error(exc)


@mcp.tool(name="withings_get_measurements", annotations=READ_ONLY)
async def withings_get_measurements(
    start_date: Annotated[str | None, Field(
        description="Inclusive start date, YYYY-MM-DD (default: 30 days ago).",
    )] = None,
    end_date: Annotated[str | None, Field(
        description="Inclusive end date, YYYY-MM-DD (default: today).",
    )] = None,
    metrics: Annotated[list[str] | None, Field(
        description=(
            "Optional list of metric names to restrict the result to, e.g. "
            "['weight', 'fat_ratio', 'muscle_mass']. Aliases such as 'body_fat', "
            "'water', 'pwv', 'bmr' are accepted. Omit for every metric."
        ),
    )] = None,
    max_sessions: Annotated[int, Field(
        ge=1, le=500,
        description="Maximum number of sessions to return, newest first (default 60).",
    )] = 60,
) -> str:
    """
    Return the user's Withings measurement history between two dates, newest
    first, merged into weigh-in sessions (readings within 10 minutes of each
    other). Use this for questions like "show my weight every day in August" or
    "what was my body fat on 2026-06-01".

    Returns JSON: {"timezone", "start", "end", "total_sessions", "returned",
    "truncated", "sessions": [ {time, epoch, device_model, sources,
    metrics: {name: {value, unit, lb?}}} ]}.
    """
    try:
        now = datetime.now(timezone.utc)
        start = _parse_day(start_date, default=now - timedelta(days=30))
        end = _parse_day(end_date, default=now, end_of_day=True)
        if end <= start:
            raise wc.WithingsError("end_date must be after start_date.")
        types = wc.resolve_metric_types(metrics) if metrics else None
        groups, tz = await _client.measure_groups(start=start, end=end, types=types)
        sessions = wc.build_sessions(groups, tz)
        return _dump({
            "timezone": tz,
            "start": start.isoformat(timespec="minutes"),
            "end": end.isoformat(timespec="minutes"),
            "total_sessions": len(sessions),
            "returned": min(max_sessions, len(sessions)),
            "truncated": len(sessions) > max_sessions,
            "sessions": sessions[:max_sessions],
        })
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool(name="withings_get_weight_trend", annotations=READ_ONLY)
async def withings_get_weight_trend(
    days: Annotated[int, Field(
        ge=2, le=3650, description="Look-back window in days (default 30).",
    )] = 30,
    include_series: Annotated[bool, Field(
        description="Also return the per-session weight and fat_ratio series (default false).",
    )] = False,
) -> str:
    """
    Summarise how weight and body composition changed over the last N days.
    For each metric present (weight, fat_ratio, fat_mass, muscle_mass, bone_mass,
    hydration, visceral_fat_index, basal_metabolic_rate, vascular_age,
    pulse_wave_velocity, heart_rate, nerve_health_score_feet, metabolic_age)
    reports first/last values, change, min, max, mean and, when both weeks have
    data, the last-7-day average versus the previous 7 days.

    Returns JSON: {"days", "timezone", "sessions", "period": {from, to},
    "metrics": {name: {unit, n, first, last, change, min, max, mean,
    last_7d_avg?, previous_7d_avg?, week_over_week_change?, change_lb?, last_lb?}},
    "series"?: [ {time, weight_kg, fat_ratio} ]}.
    """
    try:
        now = datetime.now(timezone.utc)
        groups, tz = await _client.measure_groups(start=now - timedelta(days=days), end=now)
        sessions = wc.build_sessions(groups, tz)
        if not sessions:
            return _dump({"days": days, "timezone": tz, "sessions": 0,
                          "note": "No measurements in this window."})
        chrono = list(reversed(sessions))  # oldest first
        now_epoch = time.time()
        summary: dict[str, Any] = {}
        for name in TREND_METRICS:
            points = [
                (s["time"], s["epoch"], s["metrics"][name]["value"])
                for s in chrono if name in s["metrics"]
            ]
            if not points:
                continue
            unit = next(s["metrics"][name]["unit"] for s in chrono if name in s["metrics"])
            summary[name] = _stat_block(points, unit, now_epoch)
        out: dict[str, Any] = {
            "days": days,
            "timezone": tz,
            "sessions": len(sessions),
            "period": {"from": chrono[0]["time"], "to": chrono[-1]["time"]},
            "metrics": summary,
        }
        if include_series:
            out["series"] = [
                {
                    "time": s["time"],
                    "weight_kg": s["metrics"].get("weight", {}).get("value"),
                    "fat_ratio": s["metrics"].get("fat_ratio", {}).get("value"),
                }
                for s in chrono
            ]
        return _dump(out)
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool(name="withings_list_ecg_recordings", annotations=READ_ONLY)
async def withings_list_ecg_recordings(
    days: Annotated[int, Field(
        ge=1, le=3650, description="Look-back window in days (default 30).",
    )] = 30,
    limit: Annotated[int, Field(
        ge=1, le=200, description="Maximum recordings to return, newest first (default 50).",
    )] = 50,
) -> str:
    """
    List ECG recordings stored in the Withings account (Body Scan 6-lead ECG,
    ScanWatch, BPM Core) with heart rate and the atrial-fibrillation
    classification. Does not download the raw waveform.

    Returns JSON: {"days", "total", "returned", "recordings": [ {time,
    heart_rate_bpm, afib_classification, signal_id, device_model_id,
    blood_pressure?} ]}.
    """
    try:
        now = datetime.now(timezone.utc)
        series = await _client.heart_list(now - timedelta(days=days), now)
        series.sort(key=lambda s: s.get("timestamp", 0), reverse=True)
        items = []
        for s in series[:limit]:
            ecg = s.get("ecg") or {}
            items.append({
                "time": wc.to_local(s.get("timestamp"), s.get("timezone") or ""),
                "heart_rate_bpm": s.get("heart_rate"),
                "afib_classification": AFIB.get(ecg.get("afib"), ecg.get("afib")),
                "signal_id": ecg.get("signalid"),
                "device_model_id": s.get("model"),
                "blood_pressure": s.get("bloodpressure"),
            })
        return _dump({"days": days, "total": len(series), "returned": len(items),
                      "recordings": items})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool(name="withings_get_devices", annotations=READ_ONLY)
async def withings_get_devices() -> str:
    """
    List the devices linked to the Withings account with model name, battery
    level and last sync time. Useful to check that a scale is linked and when
    it last uploaded. Requires the user.info scope.

    Returns JSON: {"count", "devices": [ {type, model, model_id, battery,
    last_sync, device_id} ]}.
    """
    try:
        devices = await _client.devices()
        items = [
            {
                "type": d.get("type"),
                "model": d.get("model"),
                "model_id": d.get("model_id"),
                "battery": d.get("battery"),
                "last_sync": wc.to_local(d.get("last_session_date"), d.get("timezone") or ""),
                "device_id": d.get("deviceid"),
            }
            for d in devices
        ]
        return _dump({"count": len(items), "devices": items})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool(name="withings_auth_status", annotations=READ_ONLY)
async def withings_auth_status(
    verify: Annotated[bool, Field(
        description="Also make a live API call to prove the saved login works (default true).",
    )] = True,
) -> str:
    """
    Report whether this server is logged in to Withings: config file location,
    token file, user id, granted scope, access-token expiry, and (optionally) a
    live API check. Call this first when another tool returns an auth error.

    Returns JSON with "logged_in": bool and, if false, a "next_step" command.
    """
    info: dict[str, Any] = {
        "config_file": str(wc.BASE_DIR / ".env"),
        "token_file": str(wc.TOKEN_FILE),
        "client_id_configured": bool(wc.CLIENT_ID),
        "redirect_uri": wc.REDIRECT_URI,
        "requested_scope": wc.SCOPE,
    }
    try:
        tokens = wc.load_tokens()
    except wc.WithingsError as exc:
        info.update({"logged_in": False, "error": str(exc)})
        return _dump(info)
    if not tokens:
        info.update({"logged_in": False, "next_step": wc.AUTH_HELP})
        return _dump(info)
    info.update({
        "logged_in": True,
        "userid": tokens.get("userid"),
        "granted_scope": tokens.get("scope"),
        "access_token_expires": datetime.fromtimestamp(
            float(tokens.get("expires_at", 0))).astimezone().isoformat(timespec="minutes"),
        "tokens_obtained": datetime.fromtimestamp(
            float(tokens.get("obtained_at", 0))).astimezone().isoformat(timespec="minutes"),
    })
    if verify:
        try:
            now = datetime.now(timezone.utc)
            groups, tz = await _client.measure_groups(
                start=now - timedelta(days=30), end=now, types=[1],
            )
            info["live_check"] = "ok"
            info["timezone"] = tz
            info["weight_readings_last_30_days"] = len(groups)
        except Exception as exc:  # noqa: BLE001
            info["live_check"] = f"failed: {exc}"
    return _dump(info)


if __name__ == "__main__":
    mcp.run(transport="stdio")
