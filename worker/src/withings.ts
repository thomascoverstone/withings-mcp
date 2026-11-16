/**
 * Withings Public Health Data API client for the Cloudflare Worker.
 *
 * Mirrors withings_client.py: token storage (Cloudflare KV) with automatic
 * refresh, thin REST wrapper, and conversion of raw measure groups into
 * readable weigh-in "sessions".
 */

export interface Env {
  TOKENS: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  WITHINGS_CLIENT_ID: string;
  WITHINGS_CLIENT_SECRET: string;
  /** Long random string that must appear in the URL path (/mcp/<key>). */
  ACCESS_KEY: string;
  /** Public https URL of this worker, used in help messages. */
  PUBLIC_URL?: string;
}

export const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
export const API_BASE = "https://wbsapi.withings.net";
export const TOKEN_URL = `${API_BASE}/v2/oauth2`;
export const SCOPE = "user.metrics,user.info";

const TOKEN_KEY = "withings:tokens";
const STATE_PREFIX = "withings:oauth_state:";
const REFRESH_MARGIN_S = 300;

export class WithingsError extends Error {}
export class NotAuthorizedError extends WithingsError {}

export interface Tokens {
  userid: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
  /** Unix seconds (same convention as the Python tokens.json). */
  expires_at: number;
  obtained_at: number;
}

// --------------------------------------------------------------------------
// Reference tables
// --------------------------------------------------------------------------

export const MEASURE_TYPES: Record<number, [string, string]> = {
  1: ["weight", "kg"],
  4: ["height", "m"],
  5: ["fat_free_mass", "kg"],
  6: ["fat_ratio", "%"],
  8: ["fat_mass", "kg"],
  9: ["diastolic_blood_pressure", "mmHg"],
  10: ["systolic_blood_pressure", "mmHg"],
  11: ["heart_rate", "bpm"],
  12: ["temperature", "degC"],
  54: ["spo2", "%"],
  71: ["body_temperature", "degC"],
  73: ["skin_temperature", "degC"],
  76: ["muscle_mass", "kg"],
  77: ["hydration", "kg"],
  88: ["bone_mass", "kg"],
  91: ["pulse_wave_velocity", "m/s"],
  123: ["vo2_max", "ml/min/kg"],
  130: ["atrial_fibrillation_result", ""],
  135: ["qrs_interval", "ms"],
  136: ["pr_interval", "ms"],
  137: ["qt_interval", "ms"],
  138: ["corrected_qt_interval", "ms"],
  139: ["atrial_fibrillation_from_ppg", ""],
  155: ["vascular_age", "years"],
  158: ["nerve_health_score_left_foot", "uS"],
  159: ["nerve_health_score_right_foot", "uS"],
  167: ["nerve_health_score_feet", "uS"],
  168: ["extracellular_water", "kg"],
  169: ["intracellular_water", "kg"],
  170: ["visceral_fat_index", ""],
  173: ["fat_free_mass_segment", "kg"],
  174: ["fat_mass_segment", "kg"],
  175: ["muscle_mass_segment", "kg"],
  196: ["electrodermal_activity_feet", "uS"],
  197: ["electrodermal_activity_left_foot", "uS"],
  198: ["electrodermal_activity_right_foot", "uS"],
  226: ["basal_metabolic_rate", "kcal"],
  227: ["metabolic_age", "years"],
};

export const NAME_TO_TYPE: Record<string, number> = Object.fromEntries(
  Object.entries(MEASURE_TYPES).map(([t, [name]]) => [name, Number(t)]),
);

const METRIC_ALIASES: Record<string, string> = {
  body_fat: "fat_ratio",
  fat_percent: "fat_ratio",
  fat_percentage: "fat_ratio",
  bodyfat: "fat_ratio",
  water: "hydration",
  body_water: "hydration",
  muscle: "muscle_mass",
  bone: "bone_mass",
  visceral_fat: "visceral_fat_index",
  pwv: "pulse_wave_velocity",
  bmr: "basal_metabolic_rate",
  pulse: "heart_rate",
  hr: "heart_rate",
};

const POSITIONS: Record<number, string> = {
  0: "right_wrist", 1: "left_wrist", 2: "right_arm", 3: "left_arm",
  4: "right_foot", 5: "left_foot", 6: "between_legs", 7: "whole_body",
  8: "left_side", 9: "right_side", 10: "left_leg", 11: "right_leg",
  12: "torso", 13: "left_hand", 14: "right_hand",
};

const ATTRIBUTIONS: Record<number, string> = {
  0: "device", 1: "device_ambiguous_user", 2: "manual_entry", 3: "user_picked",
  4: "manual_at_account_creation", 5: "device_auto", 7: "device_user_confirmed",
  15: "guided_conditions",
};

const STATUS_MESSAGES: Record<number, string> = {
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
};

export const KG_TO_LB = 2.2046226218;

// --------------------------------------------------------------------------
// Token storage (KV)
// --------------------------------------------------------------------------

export function loginUrl(env: Env): string {
  const base = env.PUBLIC_URL || "https://<your-worker-url>";
  return `${base.replace(/\/$/, "")}/auth/${env.ACCESS_KEY}`;
}

export function authHelp(env: Env): string {
  return `Log in to Withings by opening ${loginUrl(env)} in a browser.`;
}

export async function loadTokens(env: Env): Promise<Tokens | null> {
  return (await env.TOKENS.get<Tokens>(TOKEN_KEY, "json")) ?? null;
}

export async function saveTokens(env: Env, tokens: Tokens): Promise<void> {
  await env.TOKENS.put(TOKEN_KEY, JSON.stringify(tokens));
}

export async function rememberState(env: Env, state: string): Promise<void> {
  await env.TOKENS.put(STATE_PREFIX + state, "1", { expirationTtl: 600 });
}

export async function consumeState(env: Env, state: string): Promise<boolean> {
  const ok = (await env.TOKENS.get(STATE_PREFIX + state)) !== null;
  if (ok) await env.TOKENS.delete(STATE_PREFIX + state);
  return ok;
}

function nowS(): number {
  return Date.now() / 1000;
}

function withExpiry(body: Record<string, unknown>): Tokens {
  const now = nowS();
  const expiresIn = Number(body.expires_in ?? 10800) || 10800;
  return {
    userid: String(body.userid ?? ""),
    access_token: String(body.access_token),
    refresh_token: String(body.refresh_token),
    scope: String(body.scope ?? ""),
    token_type: String(body.token_type ?? "Bearer"),
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    obtained_at: now,
  };
}

function describe(payload: Record<string, unknown>, context: string): string {
  const status = Number(payload.status);
  const detail = (payload.error as string | undefined) || STATUS_MESSAGES[status] || "no description";
  return `Withings ${context} failed (status ${status}): ${detail}`;
}

async function jsonOrError(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new WithingsError(`Withings returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export class WithingsClient {
  private tokens: Tokens | null = null;
  private refreshing: Promise<Tokens> | null = null;

  constructor(private readonly env: Env) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.env.WITHINGS_CLIENT_ID,
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      action: "requesttoken",
      client_id: this.env.WITHINGS_CLIENT_ID,
      client_secret: this.env.WITHINGS_CLIENT_SECRET,
      ...fields,
    });
    const res = await fetch(TOKEN_URL, { method: "POST", body });
    const payload = await jsonOrError(res);
    if (payload.status !== 0) throw new WithingsError(describe(payload, "token request"));
    return payload.body as Record<string, unknown>;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<Tokens> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    this.tokens = withExpiry(body);
    await saveTokens(this.env, this.tokens);
    return this.tokens;
  }

  /** Refresh once even if several tool calls ask at the same time. */
  refresh(): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<Tokens> {
    const stored = await loadTokens(this.env);
    if (!stored) throw new NotAuthorizedError(`No Withings login saved yet. ${authHelp(this.env)}`);
    try {
      const body = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
      });
      this.tokens = withExpiry(body);
      await saveTokens(this.env, this.tokens);
      return this.tokens;
    } catch (err) {
      // Another isolate may have rotated the token a moment ago.
      const again = await loadTokens(this.env);
      if (again && again.refresh_token !== stored.refresh_token && again.expires_at - nowS() > 60) {
        this.tokens = again;
        return again;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new NotAuthorizedError(`The saved Withings login could not be refreshed (${msg}). ${authHelp(this.env)}`);
    }
  }

  async accessToken(force = false): Promise<string> {
    if (!this.tokens) this.tokens = await loadTokens(this.env);
    if (!this.tokens) throw new NotAuthorizedError(`No Withings login saved yet. ${authHelp(this.env)}`);
    const remaining = this.tokens.expires_at - nowS();
    if (force || remaining < REFRESH_MARGIN_S) {
      const fresh = await loadTokens(this.env);
      if (!force && fresh && fresh.expires_at - nowS() >= REFRESH_MARGIN_S) {
        this.tokens = fresh;
      } else {
        await this.refresh();
      }
    }
    return this.tokens!.access_token;
  }

  async call(
    path: string,
    action: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, any>> {
    const form = new URLSearchParams({ action });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt === 1);
      const res = await fetch(`${API_BASE}/${path}`, {
        method: "POST",
        body: form,
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await jsonOrError(res);
      if (payload.status === 0) return (payload.body as Record<string, any>) ?? {};
      if (payload.status === 401 && attempt === 0) continue;
      throw new WithingsError(describe(payload, `${path}?action=${action}`));
    }
    throw new WithingsError("unreachable");
  }

  async measureGroups(opts: {
    start?: Date;
    end?: Date;
    types?: number[];
    category?: number;
    maxPages?: number;
  } = {}): Promise<{ groups: any[]; tz: string }> {
    const params: Record<string, string | number | undefined> = { category: opts.category ?? 1 };
    if (opts.types?.length) params.meastypes = [...new Set(opts.types)].sort((a, b) => a - b).join(",");
    if (opts.start) params.startdate = Math.floor(opts.start.getTime() / 1000);
    if (opts.end) params.enddate = Math.floor(opts.end.getTime() / 1000);
    const groups: any[] = [];
    let offset: number | undefined;
    let tz = "";
    for (let page = 0; page < (opts.maxPages ?? 25); page++) {
      const body = await this.call("measure", "getmeas", { ...params, offset });
      tz = body.timezone || tz;
      groups.push(...(body.measuregrps ?? []));
      if (!body.more) break;
      offset = body.offset;
    }
    return { groups, tz };
  }

  async heartList(start: Date, end: Date, maxPages = 10): Promise<any[]> {
    const series: any[] = [];
    let offset: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.call("v2/heart", "list", {
        startdate: Math.floor(start.getTime() / 1000),
        enddate: Math.floor(end.getTime() / 1000),
        offset,
      });
      series.push(...(body.series ?? []));
      if (!body.more) break;
      offset = body.offset;
    }
    return series;
  }

  async devices(): Promise<any[]> {
    const body = await this.call("v2/user", "getdevice");
    return body.devices ?? [];
  }
}

// --------------------------------------------------------------------------
// Parsing helpers
// --------------------------------------------------------------------------

export function scaled(value: number, unit: number): number {
  return Math.round(value * 10 ** unit * 1e4) / 1e4;
}

export function toLocal(epoch: number | null | undefined, tz: string): string | null {
  if (epoch === null || epoch === undefined) return null;
  const d = new Date(Number(epoch) * 1000);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      timeZoneName: "longOffset",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const off = get("timeZoneName").replace("GMT", "") || "+00:00";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}${off}`;
  } catch {
    return d.toISOString().slice(0, 16) + "+00:00";
  }
}

export function resolveMetricTypes(names: Array<string | number>): number[] {
  const out: number[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
      out.push(Number(raw));
      continue;
    }
    let key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
    key = METRIC_ALIASES[key] ?? key;
    if (key in NAME_TO_TYPE) out.push(NAME_TO_TYPE[key]);
    else unknown.push(String(raw));
  }
  if (unknown.length) {
    throw new WithingsError(
      `Unknown metric name(s): ${unknown.join(", ")}. Known names: ${Object.keys(NAME_TO_TYPE).sort().join(", ")}`,
    );
  }
  return out;
}

export interface Metric {
  value: number;
  unit: string;
  lb?: number;
  derived?: boolean;
}

export interface Session {
  time: string | null;
  epoch: number;
  device_model: string | null;
  sources: string[];
  group_ids: number[];
  metrics: Record<string, Metric>;
}

interface ParsedGroup {
  time: string | null;
  epoch: number;
  group_id: number;
  source: string;
  device_model: string | null;
  metrics: Record<string, Metric>;
}

function parseGroup(grp: any, tz: string): ParsedGroup {
  const metrics: Record<string, Metric> = {};
  for (const m of grp.measures ?? []) {
    const [baseName, unit] = MEASURE_TYPES[m.type] ?? [`type_${m.type}`, ""];
    const value = scaled(m.value, m.unit ?? 0);
    let name = baseName;
    const pos = m.position;
    // 6 = "between legs" (foot-to-foot scale reading) and 7 = whole body are
    // both whole-body measurements; only real limb/torso positions get a suffix.
    if (pos !== undefined && pos !== null && pos !== 6 && pos !== 7) {
      name = `${baseName}_${POSITIONS[pos] ?? `position_${pos}`}`;
    }
    const entry: Metric = { value, unit };
    if (unit === "kg") entry.lb = Math.round(value * KG_TO_LB * 100) / 100;
    metrics[name] = entry;
  }
  return {
    time: toLocal(grp.date, tz),
    epoch: grp.date,
    group_id: grp.grpid,
    source: ATTRIBUTIONS[grp.attrib] ?? `attrib_${grp.attrib}`,
    device_model: grp.model ?? (grp.modelid != null ? `model_id_${grp.modelid}` : null),
    metrics,
  };
}

/**
 * Merge measure groups taken within `windowMinutes` of each other into one
 * session (a Body Scan weigh-in produces several groups). Newest first.
 */
export function buildSessions(groups: any[], tz: string, windowMinutes = 10): Session[] {
  const parsed = groups
    .filter((g) => g.measures?.length)
    .map((g) => parseGroup(g, tz))
    .sort((a, b) => b.epoch - a.epoch);
  const sessions: Array<Session & { _oldest: number }> = [];
  for (const g of parsed) {
    const last = sessions[sessions.length - 1];
    if (last && last._oldest - g.epoch <= windowMinutes * 60) {
      for (const [k, v] of Object.entries(g.metrics)) if (!(k in last.metrics)) last.metrics[k] = v;
      last.group_ids.push(g.group_id);
      if (!last.sources.includes(g.source)) last.sources.push(g.source);
      last._oldest = g.epoch;
    } else {
      sessions.push({
        time: g.time,
        epoch: g.epoch,
        device_model: g.device_model,
        sources: [g.source],
        group_ids: [g.group_id],
        metrics: { ...g.metrics },
        _oldest: g.epoch,
      });
    }
  }
  return sessions.map(({ _oldest, ...s }) => {
    const w = s.metrics.weight?.value;
    const fm = s.metrics.fat_mass?.value;
    if (w && fm && !s.metrics.fat_ratio) {
      s.metrics.fat_ratio = { value: Math.round((10000 * fm) / w) / 100, unit: "%", derived: true };
    }
    return s;
  });
}

export const TREND_METRICS = [
  "weight", "fat_ratio", "fat_mass", "muscle_mass", "bone_mass", "hydration",
  "visceral_fat_index", "basal_metabolic_rate", "vascular_age",
  "pulse_wave_velocity", "heart_rate", "nerve_health_score_feet", "metabolic_age",
];

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** sessions: newest first. Returns per-metric summary blocks. */
export function trendSummary(sessions: Session[], nowEpoch: number): Record<string, any> {
  const chrono = [...sessions].reverse();
  const summary: Record<string, any> = {};
  const week = 7 * 86400;
  for (const name of TREND_METRICS) {
    const points = chrono.filter((s) => name in s.metrics).map((s) => ({
      time: s.time, epoch: s.epoch, value: s.metrics[name].value,
    }));
    if (!points.length) continue;
    const values = points.map((p) => p.value);
    const unit = chrono.find((s) => name in s.metrics)!.metrics[name].unit;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const block: Record<string, any> = {
      unit,
      n: values.length,
      first: { time: points[0].time, value: values[0] },
      last: { time: points[points.length - 1].time, value: values[values.length - 1] },
      change: r3(values[values.length - 1] - values[0]),
      min: Math.min(...values),
      max: Math.max(...values),
      mean: r3(mean),
    };
    const recent = points.filter((p) => p.epoch >= nowEpoch - week).map((p) => p.value);
    const previous = points
      .filter((p) => p.epoch >= nowEpoch - 2 * week && p.epoch < nowEpoch - week)
      .map((p) => p.value);
    if (recent.length && previous.length) {
      block.last_7d_avg = r3(recent.reduce((a, b) => a + b, 0) / recent.length);
      block.previous_7d_avg = r3(previous.reduce((a, b) => a + b, 0) / previous.length);
      block.week_over_week_change = r3(block.last_7d_avg - block.previous_7d_avg);
    }
    if (unit === "kg") {
      block.change_lb = Math.round(block.change * KG_TO_LB * 100) / 100;
      block.last_lb = Math.round(values[values.length - 1] * KG_TO_LB * 100) / 100;
    }
    summary[name] = block;
  }
  return summary;
}
