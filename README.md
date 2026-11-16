# Withings MCP server

A local MCP server that gives Claude live, read-only access to your Withings
Body Scan 2 data: weight, body composition, segmental analysis, vascular age,
pulse wave velocity, nerve health score, heart rate, and ECG recordings.

## Files

| File | Purpose |
| --- | --- |
| `server.py` | The MCP server (stdio transport). Register this with Claude. |
| `withings_auth.py` | One-time browser login that stores OAuth tokens in `tokens.json`. |
| `withings_client.py` | Shared API client: config, token refresh, measurement parsing. |
| `.env` | Client ID / secret / redirect URI (never commit this; start from `.env.example`). |
| `tokens.json` | Created by the login script. Access + refresh tokens (never commit). |

## Setup

1. **Leave the callback URL alone.** Withings only accepts HTTPS callback
   URLs on port 443 (no localhost, no IP addresses), so the app keeps the
   pre-registered `https://wbsapi.withings.net/v2/oauth2`. `WITHINGS_REDIRECT_URI`
   in `.env` must match the dashboard Callback URL character-for-character.

2. **Log in once.**

   ```
   .venv\Scripts\python.exe withings_auth.py
   ```

   A browser opens on the Withings consent page. Click Allow. The browser
   then lands on the callback URL, which shows a JSON error page. That is
   expected: the authorization code is in the address bar. Press Ctrl+L then
   Ctrl+C. The script watches the clipboard, grabs the URL, exchanges the code
   (codes expire after 30 seconds), saves `tokens.json`, and prints your latest
   weigh-in as a live check. Pasting the URL into the terminal also works.

3. **Register the server** (already done for Claude Code and Claude Desktop
   on this machine; the entries point at `.venv\Scripts\python.exe server.py`).
   Restart Claude afterwards so it picks up the new server.

## Tools

| Tool | What it answers |
| --- | --- |
| `withings_get_latest_body_scan` | "What did I weigh this morning?" Full metric set for the latest session(s). |
| `withings_get_measurements` | History between two dates, optionally limited to named metrics. |
| `withings_get_weight_trend` | First/last/min/max/mean and week-over-week change per metric. |
| `withings_list_ecg_recordings` | ECG recordings with heart rate and AFib classification. |
| `withings_get_devices` | Linked devices, battery level, last sync. |
| `withings_auth_status` | Is the server logged in? Includes a live API check. |

## Remote server (phone, web, Claude Desktop chat)

The `worker/` folder holds the same tools as a Cloudflare Worker so Claude can
reach your data from anywhere as a **custom connector**. It is free on the
Cloudflare plan, always on, and keeps the OAuth tokens in Cloudflare KV.

| Path | Purpose |
| --- | --- |
| `worker/src/index.ts` | Routes, OAuth login/callback, the six tools. Stateless MCP since 2026-11-15: every POST is answered by one shared Durable Object that writes nothing to storage (the old McpAgent made a new Durable Object per session, ~60 rows written each, and Claude Code's reconnects nearly hit the Free plan's 100,000 rows/day). |
| `worker/src/withings.ts` | Withings client, KV token storage, session parsing (port of `withings_client.py`). |
| `worker/deploy.ps1` | One-shot deploy: KV namespace, secrets, deploy, seed tokens, repoint Claude Code. |
| `worker/update_claude_configs.py` | Switches Claude Code to the remote URL and removes the local desktop entry. |
| `worker/deploy-output.json` | Written by the deploy: worker URL, access key, connector URL. Keep private. |

Deploy once:

```
cd worker
npx wrangler login          # opens a browser; free Cloudflare account
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

Then add the connector URL printed at the end (it looks like
`https://withings-mcp.<you>.workers.dev/mcp/<key>`) in claude.ai under
**Settings > Connectors > Add custom connector**. Connectors sync to the
desktop chat and the phone app. The key in the URL is the only thing
protecting your data, so treat the URL like a password.

Logging in again later (tokens last a year): set the Withings dashboard
Callback URL to `https://<worker>/callback`, then open
`https://<worker>/auth/<key>` in a browser. No 30-second scramble; the worker
receives the redirect directly.

Only one server should own the tokens, because Withings rotates the refresh
token on every refresh. After deploying, the local Python server is
unregistered; keep it only as a fallback (it would need its own login).

## How tokens work

Withings access tokens last 3 hours; refresh tokens last a year and rotate on
every refresh. The server refreshes automatically five minutes before expiry
and writes the new pair atomically to `tokens.json`. If refreshing ever fails
(revoked app, secret renewed) the tools return an error telling you to run
`withings_auth.py` again.

## Troubleshooting

- **`invalid redirect_uri` / status 503 during login** - the redirect URI in
  `.env` does not match the dashboard character-for-character.
- **`invalid code`** - the 30-second code expired. Run the login again.
- **Tools say "No Withings login saved yet"** - run `withings_auth.py`.
- Server logs go to stderr; in Claude Code they show up in the MCP server log.
