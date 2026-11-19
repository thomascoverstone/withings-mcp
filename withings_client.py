"""
Withings Public Health Data API client, shared by the MCP server (server.py)
and the one-time login helper (withings_auth.py).

Responsibilities:
  * configuration from the .env file that sits next to this module
  * OAuth token storage (tokens.json) with automatic refresh
  * thin async wrapper around the Withings REST endpoints
  * conversion of raw "measure groups" into readable weigh-in "sessions"
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env", override=False)

AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2"
API_BASE = "https://wbsapi.withings.net"
TOKEN_URL = f"{API_BASE}/v2/oauth2"

CLIENT_ID = os.environ.get("WITHINGS_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("WITHINGS_CLIENT_SECRET", "").strip()
REDIRECT_URI = os.environ.get("WITHINGS_REDIRECT_URI", "").strip()
SCOPE = os.environ.get("WITHINGS_SCOPE", "user.metrics,user.info").strip()
TOKEN_FILE = Path(os.environ.get("WITHINGS_TOKEN_FILE") or (BASE_DIR / "tokens.json"))

# sys.executable is the interpreter running this server (normally the project's .venv), so the
# command works as printed on Windows, macOS and Linux.
AUTH_HELP = (
    "Run the one-time Withings login in a terminal: "
    f'"{sys.executable}" "{BASE_DIR / "withings_auth.py"}"'
)

# Refresh the access token when it has less than this many seconds left.
REFRESH_MARGIN_SECONDS = 300

log = logging.getLogger("withings")


class WithingsError(Exception):
    """Any failure talking to Withings."""


class NotAuthorizedError(WithingsError):
    """No usable tokens; the user has to run the login helper."""


# --------------------------------------------------------------------------
# Reference tables
# --------------------------------------------------------------------------

# meastype -> (metric name, unit).  Source: Withings API reference / aiowithings.
MEASURE_TYPES: dict[int, tuple[str, str]] = {
    1: ("weight", "kg"),
    4: ("height", "m"),
    5: ("fat_free_mass", "kg"),
    6: ("fat_ratio", "%"),
    8: ("fat_mass", "kg"),
    9: ("diastolic_blood_pressure", "mmHg"),
    10: ("systolic_blood_pressure", "mmHg"),
    11: ("heart_rate", "bpm"),
    12: ("temperature", "degC"),
    54: ("spo2", "%"),
    71: ("body_temperature", "degC"),
    73: ("skin_temperature", "degC"),
    76: ("muscle_mass", "kg"),
    77: ("hydration", "kg"),
    88: ("bone_mass", "kg"),
    91: ("pulse_wave_velocity", "m/s"),
    123: ("vo2_max", "ml/min/kg"),
    130: ("atrial_fibrillation_result", ""),
    135: ("qrs_interval", "ms"),
    136: ("pr_interval", "ms"),
    137: ("qt_interval", "ms"),
    138: ("corrected_qt_interval", "ms"),
    139: ("atrial_fibrillation_from_ppg", ""),
    155: ("vascular_age", "years"),
    158: ("nerve_health_score_left_foot", "uS"),
    159: ("nerve_health_score_right_foot", "uS"),
    167: ("nerve_health_score_feet", "uS"),
    168: ("extracellular_water", "kg"),
    169: ("intracellular_water", "kg"),
    170: ("visceral_fat_index", ""),
    173: ("fat_free_mass_segment", "kg"),
    174: ("fat_mass_segment", "kg"),
    175: ("muscle_mass_segment", "kg"),
    196: ("electrodermal_activity_feet", "uS"),
    197: ("electrodermal_activity_left_foot", "uS"),
    198: ("electrodermal_activity_right_foot", "uS"),
    226: ("basal_metabolic_rate", "kcal"),
    227: ("metabolic_age", "years"),
}
NAME_TO_TYPE: dict[str, int] = {name: t for t, (name, _) in MEASURE_TYPES.items()}

# Convenience aliases users are likely to say.
METRIC_ALIASES: dict[str, str] = {
    "body_fat": "fat_ratio",
    "fat_percent": "fat_ratio",
    "fat_percentage": "fat_ratio",
    "bodyfat": "fat_ratio",
    "water": "hydration",
    "body_water": "hydration",
    "muscle": "muscle_mass",
    "bone": "bone_mass",
    "visceral_fat": "visceral_fat_index",
    "pwv": "pulse_wave_velocity",
    "bmr": "basal_metabolic_rate",
    "pulse": "heart_rate",
    "hr": "heart_rate",
}

# Position codes used by segmental body-composition measures.
POSITIONS: dict[int, str] = {
    0: "right_wrist",
    1: "left_wrist",
    2: "right_arm",
    3: "left_arm",
    4: "right_foot",
    5: "left_foot",
    6: "between_legs",
    7: "whole_body",
    8: "left_side",
    9: "right_side",
    10: "left_leg",
    11: "right_leg",
    12: "torso",
    13: "left_hand",
    14: "right_hand",
}

# measuregrp.attrib -> how the measurement was captured.
ATTRIBUTIONS: dict[int, str] = {
    0: "device",
    1: "device_ambiguous_user",
    2: "manual_entry",
    3: "user_picked",
    4: "manual_at_account_creation",
    5: "device_auto",
    7: "device_user_confirmed",
    15: "guided_conditions",
}

STATUS_MESSAGES: dict[int, str] = {
    100: "invalid hash / timestamp",
    247: "the userid is absent or invalid",
    250: "the userid and/or OAuth credentials do not match",
    293: "the callback URL is absent or incorrect",
    342: "the signature is invalid",
    401: "the access token is invalid or expired",
    503: "invalid parameters",
    601: "too many requests (rate limited) - wait a minute and retry",
    2554: "wrong action or web service",
    2555: "unknown error on the Withings side",
    2556: "service is not defined",
}

KG_TO_LB = 2.2046226218


# --------------------------------------------------------------------------
# Config / token storage
# --------------------------------------------------------------------------

def require_config() -> None:
    missing = [
        name for name, val in (
            ("WITHINGS_CLIENT_ID", CLIENT_ID),
            ("WITHINGS_CLIENT_SECRET", CLIENT_SECRET),
            ("WITHINGS_REDIRECT_URI", REDIRECT_URI),
        ) if not val
    ]
    if missing:
        raise WithingsError(
            f"Missing {', '.join(missing)} in {BASE_DIR / '.env'}. "
            "Copy the values from the Withings developer dashboard."
        )


def load_tokens() -> dict[str, Any] | None:
    try:
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise WithingsError(
            f"{TOKEN_FILE} is corrupt ({exc}). Delete it and log in again. {AUTH_HELP}"
        ) from exc


def save_tokens(tokens: dict[str, Any]) -> None:
    """Atomic write: Withings refresh tokens are single-use, so never lose one."""
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=TOKEN_FILE.parent, prefix=".tokens-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(tokens, fh, indent=2)
        os.replace(tmp, TOKEN_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _with_expiry(body: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    expires_in = int(body.get("expires_in") or 10800)
    return {
        "userid": str(body.get("userid", "")),
        "access_token": body["access_token"],
        "refresh_token": body["refresh_token"],
        "scope": body.get("scope", ""),
        "token_type": body.get("token_type", "Bearer"),
        "expires_in": expires_in,
        "expires_at": now + expires_in,
        "obtained_at": now,
    }


def _json_or_error(resp: httpx.Response) -> dict[str, Any]:
    try:
        payload = resp.json()
    except ValueError as exc:
        raise WithingsError(
            f"Withings returned HTTP {resp.status_code} with a non-JSON body: {resp.text[:200]!r}"
        ) from exc
    if not isinstance(payload, dict):
        raise WithingsError(f"Unexpected Withings response: {payload!r}")
    return payload


def _describe(payload: dict[str, Any], context: str) -> str:
    status = payload.get("status")
    detail = payload.get("error") or STATUS_MESSAGES.get(status, "no description")
    return f"Withings {context} failed (status {status}): {detail}"


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------

class WithingsClient:
    def __init__(self, http: httpx.AsyncClient | None = None):
        self._http = http or httpx.AsyncClient(timeout=30.0)
        self._tokens: dict[str, Any] | None = None

    async def aclose(self) -> None:
        await self._http.aclose()

    # ---- OAuth -----------------------------------------------------------

    @staticmethod
    def authorize_url(state: str) -> str:
        require_config()
        return AUTHORIZE_URL + "?" + urlencode({
            "response_type": "code",
            "client_id": CLIENT_ID,
            "scope": SCOPE,
            "redirect_uri": REDIRECT_URI,
            "state": state,
        })

    async def _token_request(self, **fields: str) -> dict[str, Any]:
        require_config()
        data = {
            "action": "requesttoken",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            **fields,
        }
        resp = await self._http.post(TOKEN_URL, data=data)
        payload = _json_or_error(resp)
        if payload.get("status") != 0:
            raise WithingsError(_describe(payload, "token request"))
        return payload["body"]

    async def exchange_code(self, code: str) -> dict[str, Any]:
        body = await self._token_request(
            grant_type="authorization_code", code=code, redirect_uri=REDIRECT_URI
        )
        self._tokens = _with_expiry(body)
        save_tokens(self._tokens)
        return self._tokens

    async def refresh(self) -> dict[str, Any]:
        # Always start from the on-disk copy: the login helper may have
        # replaced it while this process was running.
        tokens = load_tokens()
        if not tokens:
            raise NotAuthorizedError(f"No Withings login saved yet. {AUTH_HELP}")
        try:
            body = await self._token_request(
                grant_type="refresh_token", refresh_token=tokens["refresh_token"]
            )
        except WithingsError as exc:
            raise NotAuthorizedError(
                f"The saved Withings login could not be refreshed ({exc}). {AUTH_HELP}"
            ) from exc
        self._tokens = _with_expiry(body)
        save_tokens(self._tokens)
        log.info("refreshed Withings access token (user %s)", self._tokens["userid"])
        return self._tokens

    async def access_token(self, force_refresh: bool = False) -> str:
        if self._tokens is None:
            self._tokens = load_tokens()
        if self._tokens is None:
            raise NotAuthorizedError(f"No Withings login saved yet. {AUTH_HELP}")
        remaining = float(self._tokens.get("expires_at", 0)) - time.time()
        if force_refresh or remaining < REFRESH_MARGIN_SECONDS:
            on_disk = load_tokens()
            if (
                not force_refresh
                and on_disk
                and float(on_disk.get("expires_at", 0)) - time.time() >= REFRESH_MARGIN_SECONDS
            ):
                self._tokens = on_disk  # another process already refreshed
            else:
                await self.refresh()
        return self._tokens["access_token"]

    # ---- Generic call ----------------------------------------------------

    async def call(self, path: str, action: str, **params: Any) -> dict[str, Any]:
        data = {"action": action, **{k: v for k, v in params.items() if v is not None}}
        for attempt in range(2):
            token = await self.access_token(force_refresh=(attempt == 1))
            resp = await self._http.post(
                f"{API_BASE}/{path}", data=data,
                headers={"Authorization": f"Bearer {token}"},
            )
            payload = _json_or_error(resp)
            status = payload.get("status")
            if status == 0:
                return payload.get("body") or {}
            if status == 401 and attempt == 0:
                log.info("access token rejected; refreshing and retrying")
                continue
            raise WithingsError(_describe(payload, f"{path}?action={action}"))
        raise WithingsError("unreachable")

    # ---- Endpoints -------------------------------------------------------

    async def measure_groups(
        self,
        start: datetime | None = None,
        end: datetime | None = None,
        types: Iterable[int] | None = None,
        category: int = 1,
        max_pages: int = 25,
    ) -> tuple[list[dict[str, Any]], str]:
        """Return (raw measure groups, account timezone) for the given window."""
        params: dict[str, Any] = {"category": category}
        if types:
            params["meastypes"] = ",".join(str(t) for t in sorted(set(types)))
        if start:
            params["startdate"] = int(start.timestamp())
        if end:
            params["enddate"] = int(end.timestamp())
        groups: list[dict[str, Any]] = []
        offset: int | None = None
        tz = ""
        for _ in range(max_pages):
            body = await self.call("measure", "getmeas", offset=offset, **params)
            tz = body.get("timezone") or tz
            groups.extend(body.get("measuregrps") or [])
            if not body.get("more"):
                break
            offset = body.get("offset")
        return groups, tz

    async def heart_list(
        self, start: datetime, end: datetime, max_pages: int = 10
    ) -> list[dict[str, Any]]:
        series: list[dict[str, Any]] = []
        offset: int | None = None
        for _ in range(max_pages):
            body = await self.call(
                "v2/heart", "list",
                startdate=int(start.timestamp()), enddate=int(end.timestamp()), offset=offset,
            )
            series.extend(body.get("series") or [])
            if not body.get("more"):
                break
            offset = body.get("offset")
        return series

    async def devices(self) -> list[dict[str, Any]]:
        body = await self.call("v2/user", "getdevice")
        return body.get("devices") or []


# --------------------------------------------------------------------------
# Parsing helpers
# --------------------------------------------------------------------------

def scaled(value: int, unit: int) -> float:
    return round(value * (10 ** unit), 4)


def to_local(epoch: int | None, tz: str) -> str | None:
    if epoch is None:
        return None
    try:
        tzinfo = ZoneInfo(tz) if tz else timezone.utc
    except ZoneInfoNotFoundError:
        tzinfo = timezone.utc
    return datetime.fromtimestamp(int(epoch), tzinfo).isoformat(timespec="minutes")


def resolve_metric_types(names: Iterable[str | int]) -> list[int]:
    """Turn metric names / aliases / raw type codes into Withings meastype ints."""
    out: list[int] = []
    unknown: list[str] = []
    for raw in names:
        if isinstance(raw, int) or str(raw).isdigit():
            out.append(int(raw))
            continue
        key = str(raw).strip().lower().replace(" ", "_").replace("-", "_")
        key = METRIC_ALIASES.get(key, key)
        if key in NAME_TO_TYPE:
            out.append(NAME_TO_TYPE[key])
        else:
            unknown.append(str(raw))
    if unknown:
        raise WithingsError(
            f"Unknown metric name(s): {', '.join(unknown)}. "
            f"Known names: {', '.join(sorted(NAME_TO_TYPE))}"
        )
    return out


def parse_group(grp: dict[str, Any], tz: str) -> dict[str, Any]:
    metrics: dict[str, dict[str, Any]] = {}
    for m in grp.get("measures") or []:
        name, unit = MEASURE_TYPES.get(m["type"], (f"type_{m['type']}", ""))
        value = scaled(m["value"], m.get("unit", 0))
        pos = m.get("position")
        # 6 = "between legs" (foot-to-foot scale reading) and 7 = whole body are
        # both whole-body measurements; only real limb/torso positions get a suffix.
        if pos is not None and pos not in (6, 7):
            name = f"{name}_{POSITIONS.get(pos, f'position_{pos}')}"
        entry: dict[str, Any] = {"value": value, "unit": unit}
        if unit == "kg":
            entry["lb"] = round(value * KG_TO_LB, 2)
        metrics[name] = entry
    return {
        "time": to_local(grp.get("date"), tz),
        "epoch": grp.get("date"),
        "group_id": grp.get("grpid"),
        "source": ATTRIBUTIONS.get(grp.get("attrib", -1), f"attrib_{grp.get('attrib')}"),
        "device_model": grp.get("model")
        or (f"model_id_{grp['modelid']}" if grp.get("modelid") is not None else None),
        "metrics": metrics,
    }


def build_sessions(
    groups: list[dict[str, Any]], tz: str, window_minutes: int = 10
) -> list[dict[str, Any]]:
    """
    Merge measure groups taken within `window_minutes` of each other into one
    "session" (one weigh-in on a body-composition scale typically produces several
    groups: body composition, then vascular metrics a few seconds later).  Newest first.
    """
    parsed = sorted(
        (parse_group(g, tz) for g in groups if g.get("measures")),
        key=lambda g: g["epoch"], reverse=True,
    )
    sessions: list[dict[str, Any]] = []
    for g in parsed:
        if sessions and sessions[-1]["_oldest"] - g["epoch"] <= window_minutes * 60:
            s = sessions[-1]
            for key, val in g["metrics"].items():
                s["metrics"].setdefault(key, val)
            s["group_ids"].append(g["group_id"])
            if g["source"] not in s["sources"]:
                s["sources"].append(g["source"])
            s["_oldest"] = g["epoch"]
        else:
            sessions.append({
                "time": g["time"],
                "epoch": g["epoch"],
                "device_model": g["device_model"],
                "sources": [g["source"]],
                "group_ids": [g["group_id"]],
                "metrics": dict(g["metrics"]),
                "_oldest": g["epoch"],
            })
    for s in sessions:
        s.pop("_oldest", None)
        w = s["metrics"].get("weight", {}).get("value")
        fm = s["metrics"].get("fat_mass", {}).get("value")
        if w and fm and "fat_ratio" not in s["metrics"]:
            s["metrics"]["fat_ratio"] = {
                "value": round(100 * fm / w, 2), "unit": "%", "derived": True,
            }
    return sessions
