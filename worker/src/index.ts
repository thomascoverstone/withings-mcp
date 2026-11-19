/**
 * Withings MCP server as a Cloudflare Worker (remote MCP, streamable HTTP).
 *
 * Routes (everything except / and /callback needs a secret in the path):
 *   GET  /                    liveness text
 *   HEAD /callback            200, so the callback URL check in the Withings dashboard passes
 *   GET  /callback            OAuth redirect target: exchanges the code, stores tokens in KV
 *   GET  /auth/<login key>    starts the Withings login (redirects to the consent page); the
 *                             login key is derived from ACCESS_KEY, see loginKey() in withings.ts
 *   POST /mcp/<ACCESS_KEY>    MCP endpoint (stateless streamable HTTP): the custom connector URL
 *   GET  /mcp/<ACCESS_KEY>    405: no event stream, so idle clients have nothing to keep open
 */
import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  type Env,
  type Session,
  WithingsClient,
  WithingsError,
  buildSessions,
  consumeState,
  loadTokens,
  loginKey,
  loginUrl,
  rememberState,
  resolveMetricTypes,
  toLocal,
  trendSummary,
} from "./withings";

type Props = { origin: string };

const INSTRUCTIONS =
  "Live, read-only access to the user's Withings account: weigh-ins and body composition from " +
  "Withings scales, ECG recordings and linked devices. Masses come back in kg with an lb " +
  "conversion, fat_ratio is a percent, and times are ISO-8601 in the user's Withings timezone. " +
  "Use withings_get_latest_body_scan for 'what did I weigh today' questions, " +
  "withings_get_weight_trend for how things are changing, and withings_get_measurements for raw " +
  "history between dates. If a tool answers with an error saying no login is saved, give the " +
  "user the login link it contains.";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const AFIB: Record<number, string> = { 0: "negative", 1: "positive", 2: "inconclusive" };
const DAY_MS = 86_400_000;

const dump = (data: unknown) => JSON.stringify(data, null, 2);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: dump(data) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: dump({ error: err instanceof Error ? err.message : String(err) }) }],
  isError: true,
});

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value: string | undefined, dflt: Date, endOfDay = false): Date {
  if (!value) return dflt;
  const t = value.trim();
  const m = BARE_DATE.exec(t);
  let d: Date;
  if (m) {
    d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    // Date.UTC rolls impossible days over (Feb 30 becomes Mar 2): refuse them instead.
    if (d.toISOString().slice(0, 10) !== t) throw new WithingsError(`Bad date '${value}'; use YYYY-MM-DD.`);
    if (endOfDay) d = new Date(d.getTime() + DAY_MS);
  } else {
    d = new Date(t);
  }
  if (Number.isNaN(d.getTime())) throw new WithingsError(`Bad date '${value}'; use YYYY-MM-DD.`);
  return d;
}

// --------------------------------------------------------------------------
// MCP server: a fresh, stateless instance for every HTTP request
// --------------------------------------------------------------------------

class WithingsServer {
  server = new McpServer({ name: "withings", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  private client!: WithingsClient;
  private readonly env: Env;
  private readonly props: Props | undefined;

  constructor(env: Env, props?: Props) {
    this.env = env;
    this.props = props;
  }

  private envWithOrigin(): Env {
    const origin = this.props?.origin;
    return origin ? { ...this.env, PUBLIC_URL: this.env.PUBLIC_URL || origin } : this.env;
  }

  async init(): Promise<void> {
    const env = this.envWithOrigin();
    this.client = new WithingsClient(env);

    this.server.registerTool(
      "withings_get_latest_body_scan",
      {
        title: "Latest weigh-in",
        description:
          "Return the most recent weigh-in(s) from the user's Withings scale with every metric " +
          "captured: weight, fat_ratio, fat_mass, fat_free_mass, muscle_mass, bone_mass, hydration, " +
          "extracellular/intracellular water, visceral_fat_index, basal_metabolic_rate, metabolic_age, " +
          "heart_rate, pulse_wave_velocity, vascular_age, nerve_health_score_*, electrodermal_activity_*, " +
          "and segmental fat/muscle masses per limb and torso (which metrics appear depends on the scale " +
          "model). Readings within 10 minutes are merged into one session. Searches the last 90 days, " +
          "then the last 2 years. Returns JSON " +
          "{timezone, returned, sessions:[{time, epoch, device_model, sources, metrics:{name:{value, unit, lb?}}}]}.",
        inputSchema: {
          count: z.number().int().min(1).max(20).default(1)
            .describe("How many of the most recent weigh-in sessions to return (default 1)."),
        },
        annotations: READ_ONLY,
      },
      async ({ count }) => {
        try {
          const now = new Date();
          let sessions: Session[] = [];
          let tz = "";
          for (const days of [90, 730]) {
            const r = await this.client.measureGroups({ start: new Date(now.getTime() - days * DAY_MS), end: now });
            tz = r.tz;
            sessions = buildSessions(r.groups, tz);
            if (sessions.length) break;
          }
          if (!sessions.length) {
            return ok({ timezone: tz, returned: 0, sessions: [], note: "No measurements were found in the last 2 years." });
          }
          return ok({ timezone: tz, returned: Math.min(count, sessions.length), sessions: sessions.slice(0, count) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "withings_get_measurements",
      {
        title: "Measurement history",
        description:
          "Return the user's Withings measurement history between two dates, newest first, merged into " +
          "weigh-in sessions. Use for 'show my weight every day in August' or 'what was my body fat on " +
          "2026-06-01'. Returns JSON {timezone, start, end, total_sessions, returned, truncated, " +
          "sessions:[{time, epoch, device_model, sources, metrics:{name:{value, unit, lb?}}}]}.",
        inputSchema: {
          start_date: z.string().optional().describe("Inclusive start date, YYYY-MM-DD (default: 30 days ago)."),
          end_date: z.string().optional().describe("Inclusive end date, YYYY-MM-DD (default: today)."),
          metrics: z.array(z.string()).optional().describe(
            "Optional metric names to restrict to, e.g. ['weight','fat_ratio','muscle_mass']. " +
            "Aliases like 'body_fat', 'water', 'pwv', 'bmr' work. Omit for every metric.",
          ),
          max_sessions: z.number().int().min(1).max(500).default(60)
            .describe("Maximum sessions to return, newest first (default 60)."),
        },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, metrics, max_sessions }) => {
        try {
          const now = new Date();
          const start = parseDay(start_date, new Date(now.getTime() - 30 * DAY_MS));
          const end = parseDay(end_date, now, true);
          if (end <= start) throw new WithingsError("end_date must be after start_date.");
          const types = metrics?.length ? resolveMetricTypes(metrics) : undefined;
          // Query one day wider on each side, then trim by the user's local date.
          const r = await this.client.measureGroups({
            start: new Date(start.getTime() - DAY_MS),
            end: new Date(end.getTime() + DAY_MS),
            types,
          });
          const loDay = start_date && BARE_DATE.test(start_date.trim()) ? start_date.trim() : null;
          const hiDay = end_date && BARE_DATE.test(end_date.trim()) ? end_date.trim() : null;
          const startS = start.getTime() / 1000;
          const endS = end.getTime() / 1000;
          const sessions = buildSessions(r.groups, r.tz).filter((s) => {
            const day = s.time?.slice(0, 10) ?? "";
            if (loDay ? day < loDay : s.epoch < startS) return false;
            if (hiDay ? day > hiDay : s.epoch >= endS) return false;
            return true;
          });
          return ok({
            timezone: r.tz,
            start: loDay ?? start.toISOString(),
            end: hiDay ?? end.toISOString(),
            total_sessions: sessions.length,
            returned: Math.min(max_sessions, sessions.length),
            truncated: sessions.length > max_sessions,
            sessions: sessions.slice(0, max_sessions),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "withings_get_weight_trend",
      {
        title: "Weight and body-composition trend",
        description:
          "Summarise how weight and body composition changed over the last N days: per metric " +
          "(weight, fat_ratio, fat_mass, muscle_mass, bone_mass, hydration, visceral_fat_index, " +
          "basal_metabolic_rate, vascular_age, pulse_wave_velocity, heart_rate, nerve_health_score_feet, " +
          "metabolic_age) first/last, change, min, max, mean and last-7-day vs previous-7-day averages. " +
          "Returns JSON {days, timezone, sessions, period:{from,to}, metrics:{name:{...}}, series?}.",
        inputSchema: {
          days: z.number().int().min(2).max(3650).default(30).describe("Look-back window in days (default 30)."),
          include_series: z.boolean().default(false)
            .describe("Also return the per-session weight and fat_ratio series (default false)."),
        },
        annotations: READ_ONLY,
      },
      async ({ days, include_series }) => {
        try {
          const now = new Date();
          const r = await this.client.measureGroups({ start: new Date(now.getTime() - days * DAY_MS), end: now });
          const sessions = buildSessions(r.groups, r.tz);
          if (!sessions.length) return ok({ days, timezone: r.tz, sessions: 0, note: "No measurements in this window." });
          const chrono = [...sessions].reverse();
          const out: Record<string, unknown> = {
            days,
            timezone: r.tz,
            sessions: sessions.length,
            period: { from: chrono[0].time, to: chrono[chrono.length - 1].time },
            metrics: trendSummary(sessions, Date.now() / 1000),
          };
          if (include_series) {
            out.series = chrono.map((s) => ({
              time: s.time,
              weight_kg: s.metrics.weight?.value ?? null,
              fat_ratio: s.metrics.fat_ratio?.value ?? null,
            }));
          }
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "withings_list_ecg_recordings",
      {
        title: "ECG recordings",
        description:
          "List ECG recordings in the Withings account (Body Scan 6-lead ECG, ScanWatch, BPM Core) with " +
          "heart rate and atrial-fibrillation classification. Does not download the waveform. Returns JSON " +
          "{days, total, returned, recordings:[{time, heart_rate_bpm, afib_classification, signal_id, device_model_id, blood_pressure?}]}.",
        inputSchema: {
          days: z.number().int().min(1).max(3650).default(30).describe("Look-back window in days (default 30)."),
          limit: z.number().int().min(1).max(200).default(50).describe("Maximum recordings, newest first (default 50)."),
        },
        annotations: READ_ONLY,
      },
      async ({ days, limit }) => {
        try {
          const now = new Date();
          const series = await this.client.heartList(new Date(now.getTime() - days * DAY_MS), now);
          series.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          const recordings = series.slice(0, limit).map((s) => {
            const ecg = s.ecg ?? {};
            return {
              time: toLocal(s.timestamp, s.timezone ?? ""),
              heart_rate_bpm: s.heart_rate ?? null,
              afib_classification: AFIB[ecg.afib] ?? ecg.afib ?? null,
              signal_id: ecg.signalid ?? null,
              device_model_id: s.model ?? null,
              blood_pressure: s.bloodpressure ?? null,
            };
          });
          return ok({ days, total: series.length, returned: recordings.length, recordings });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "withings_get_devices",
      {
        title: "Linked Withings devices",
        description:
          "List devices linked to the Withings account with model, battery level and last sync time. " +
          "Use it to check that a scale is linked and when it last uploaded. Returns JSON " +
          "{count, devices:[{type, model, model_id, battery, last_sync, device_id}]}.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => {
        try {
          const devices = await this.client.devices();
          return ok({
            count: devices.length,
            devices: devices.map((d) => ({
              type: d.type ?? null,
              model: d.model ?? null,
              model_id: d.model_id ?? null,
              battery: d.battery ?? null,
              last_sync: toLocal(d.last_session_date, d.timezone ?? ""),
              device_id: d.deviceid ?? null,
            })),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "withings_auth_status",
      {
        title: "Withings login status",
        description:
          "Report whether this server is logged in to Withings: user id, granted scope, token expiry, " +
          "an optional live API check, and the login link to use if not. Call this first when another " +
          "tool returns an auth error.",
        inputSchema: {
          verify: z.boolean().default(true).describe("Also make a live API call to prove the saved login works (default true)."),
        },
        annotations: READ_ONLY,
      },
      async ({ verify }) => {
        const info: Record<string, unknown> = { login_url: await loginUrl(env) };
        try {
          const tokens = await loadTokens(env);
          if (!tokens) {
            return ok({ ...info, logged_in: false, next_step: "Open login_url in a browser and approve access." });
          }
          Object.assign(info, {
            logged_in: true,
            userid: tokens.userid,
            granted_scope: tokens.scope,
            access_token_expires: new Date(tokens.expires_at * 1000).toISOString(),
            tokens_obtained: new Date(tokens.obtained_at * 1000).toISOString(),
          });
          if (verify) {
            try {
              const now = new Date();
              const r = await this.client.measureGroups({ start: new Date(now.getTime() - 30 * DAY_MS), end: now, types: [1] });
              info.live_check = "ok";
              info.timezone = r.tz;
              info.weight_readings_last_30_days = r.groups.length;
            } catch (e) {
              info.live_check = `failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          return ok(info);
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

/**
 * The MCP endpoint's Durable Object. Every client shares ONE instance ("shared") and the server is
 * stateless (a fresh McpServer per request, no session ids), so nothing is written to Durable
 * Object storage and the Free plan's daily row-write limit is never touched. Tool calls run here
 * rather than in the Worker only to get the Durable Object CPU budget (Free plan Workers get 10 ms
 * of CPU per request).
 */
export class WithingsMCP extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const mcp = new WithingsServer(this.env, { origin: new URL(request.url).origin });
    await mcp.init();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session ids, nothing to remember
      enableJsonResponse: true, // plain JSON replies instead of event streams
    });
    await mcp.server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await mcp.server.close();
    }
  }
}

// --------------------------------------------------------------------------
// HTTP routing
// --------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") {
    // Stateless server: no event stream to open (GET) and no session to end (DELETE).
    // MCP clients treat 405 as "not offered" and carry on.
    return withCors(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405, headers: { Allow: "POST, OPTIONS" } },
      ),
    );
  }
  const shared = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("shared"));
  return withCors(await shared.fetch(request));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(status: number, title: string, detail: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:34rem;text-align:center">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function startLogin(url: URL, env: Env): Promise<Response> {
  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await rememberState(env, state);
  const client = new WithingsClient(env);
  return Response.redirect(client.authorizeUrl(state, `${url.origin}/callback`), 302);
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) return page(400, "Withings login failed", `${error} ${url.searchParams.get("error_description") ?? ""}`.trim());
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page(400, "Missing code or state", "Start the login from the /auth link instead.");
  if (!(await consumeState(env, state))) {
    return page(400, "Login link expired", "Login links are valid for 10 minutes. Open the /auth link again.");
  }
  try {
    const tokens = await new WithingsClient(env).exchangeCode(code, `${url.origin}/callback`);
    return page(
      200,
      "Withings connected",
      `Logged in as Withings user ${tokens.userid} (scope: ${tokens.scope}). You can close this tab and ask Claude about your Withings data.`,
    );
  } catch (e) {
    return page(502, "Withings login failed", e instanceof Error ? e.message : String(e));
  }
}

/** Constant-time comparison for the secrets in the URL path. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") return new Response("withings-mcp is running.\n", { headers: { "content-type": "text/plain" } });
    if (path === "/callback") {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      return handleCallback(url, env);
    }
    const key = env.ACCESS_KEY;
    if (!key || key.length < 12) return new Response("Worker is not configured: ACCESS_KEY secret missing.", { status: 500 });

    const [, route, secret, ...rest] = path.split("/");
    if (secret && rest.length === 0) {
      if (route === "mcp" && sameSecret(secret, key)) return handleMcp(request, env);
      if (route === "auth" && sameSecret(secret, await loginKey(key))) return startLogin(url, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
