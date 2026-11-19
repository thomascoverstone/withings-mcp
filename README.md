# Withings MCP server

Gives Claude live, read-only access to your own Withings data: weigh-ins and
body composition (fat, muscle, bone, water, visceral fat, segmental
analysis), vascular age, pulse wave velocity, nerve health score, heart rate,
ECG recordings and your linked devices. Which metrics you get depends on your
devices.

It comes in two forms with the same six tools:

| | Remote server (recommended) | Local server |
| --- | --- | --- |
| Runs on | a Cloudflare Worker in your own Cloudflare account (the free plan is enough) | your computer, in Python |
| Works with | claude.ai, Claude Desktop, the Claude mobile apps, Claude Code | Claude Desktop and Claude Code on that computer |
| Code | [`worker/`](worker) (TypeScript) | [`server.py`](server.py), [`withings_client.py`](withings_client.py), [`withings_auth.py`](withings_auth.py) |

You set everything up under your own accounts: your Withings developer app,
your Cloudflare account and your Claude account. No third-party server is
involved.

> **Disclaimer.** This is an independent project, not affiliated with or
> endorsed by Withings. It is not a medical device, and what it reports is
> not medical advice.

## Tools

| Tool | What it answers |
| --- | --- |
| `withings_get_latest_body_scan` | "What did I weigh this morning?" Every metric of the latest weigh-in(s). |
| `withings_get_measurements` | History between two dates, optionally limited to named metrics. |
| `withings_get_weight_trend` | First/last/min/max/mean and week-over-week change per metric. |
| `withings_list_ecg_recordings` | ECG recordings with heart rate and AFib classification. |
| `withings_get_devices` | Linked devices, battery level, last sync. |
| `withings_auth_status` | Is the server logged in? Includes a live API check and how to log in. |

All tools are read-only. Masses come in kg with an lb conversion, and times
are in your Withings time zone.

## 1. Get the code and create a Withings app

```bash
git clone https://github.com/thomascoverstone/withings-mcp.git
cd withings-mcp
```

1. Sign in at [developer.withings.com](https://developer.withings.com/) with
   your Withings account and create an application for the public API.
2. For its callback URL, enter `https://wbsapi.withings.net/v2/oauth2` for
   now. The remote server gets its own callback URL once it is deployed.
3. Copy `.env.example` to `.env` (on Windows: `copy .env.example .env`) and
   fill in the app's client ID and client secret. `.env` is git-ignored.

Then set up the remote server (2a), the local server (2b), or both.

## 2a. Remote server on Cloudflare (recommended)

You need [Node.js](https://nodejs.org/) 22 or newer and a free
[Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd worker
npm install
npx wrangler login     # once per computer; opens a browser
npm run setup
```

`npm run setup` works on Windows, macOS and Linux. It deploys the worker
(the first deploy also creates the KV namespace that keeps your login),
uploads your Withings credentials and a random access key as Worker secrets,
and prints three links, which it also saves to `worker/deploy-output.json`
(git-ignored). Then:

1. **Callback URL.** In your Withings app, set the callback URL to the
   printed `https://withings-mcp.<your-subdomain>.workers.dev/callback`. If
   you also use the local server, keep `https://wbsapi.withings.net/v2/oauth2`
   as well: an app can list several callback URLs, separated by commas.
2. **Login link.** Open the printed `https://…/auth/…` link, sign in to
   Withings and allow access. The worker receives the redirect itself and
   saves the login.
3. **Connector URL.** Add the printed `https://…/mcp/…` URL to Claude:
   - claude.ai, Claude Desktop and the Claude mobile apps: **Settings →
     Connectors → Add custom connector**, name it Withings and paste the URL.
     A connector added there shows up in all three.
   - Claude Code: `claude mcp add --transport http --scope user withings <connector URL>`

Then ask Claude something like "What did I weigh this morning?".

To update, pull the changes and run `npm run setup` again. It reuses the
access key saved in `deploy-output.json`, so your connector URL stays the
same. To redeploy from another computer, copy that file over first;
otherwise setup creates a new key and you have to update the connector. For
the other options, see `npm run setup -- --help`.

## 2b. Local server (Python)

You need Python 3.10 or newer.

```bash
python -m venv .venv
# Windows:        .venv\Scripts\activate
# macOS / Linux:  source .venv/bin/activate
pip install -r requirements.txt
python withings_auth.py
```

`withings_auth.py` opens the Withings consent page. After you click Allow,
the browser lands on `wbsapi.withings.net` and shows an error page. That is
expected: the authorization code is in the address bar. Copy the address
(Ctrl+L, Ctrl+C; on macOS Cmd+L, Cmd+C) and the script, which watches the
clipboard, exchanges the code right away (it expires after 30 seconds),
saves `tokens.json` (git-ignored) and prints your latest weigh-in as a check.
Pasting the address into the terminal works too. On Linux the clipboard is
read with `wl-paste`, `xclip` or `xsel` when one is installed.

Then register the server with absolute paths. On Windows the interpreter is
`.venv\Scripts\python.exe` instead of `.venv/bin/python`.

- Claude Code:

  ```bash
  claude mcp add --scope user withings -- /path/to/withings-mcp/.venv/bin/python /path/to/withings-mcp/server.py
  ```

- Claude Desktop: open **Settings → Developer → Edit Config**, add the server
  to `claude_desktop_config.json` and restart Claude Desktop:

  ```json
  {
    "mcpServers": {
      "withings": {
        "command": "/path/to/withings-mcp/.venv/bin/python",
        "args": ["/path/to/withings-mcp/server.py"]
      }
    }
  }
  ```

  Windows paths need doubled backslashes in JSON, for example
  `"C:\\Users\\you\\withings-mcp\\.venv\\Scripts\\python.exe"`.

## Security

- **The connector URL is the password.** Its last part is the worker's
  `ACCESS_KEY`, and anyone who has the URL can read your Withings data
  through the tools. Keep it private.
- **The login link only starts a login.** It ends in a key derived from
  `ACCESS_KEY` (HMAC-SHA256), so it does not reveal the connector URL even
  though `withings_auth_status` and login errors show it to Claude. It can't
  read your data, but someone who has it could log the worker in to a
  different Withings account, so keep it private too.
- **Rotate the key** with `npm run setup -- --rotate-key` if a link leaks. The
  old connector URL and login link stop working; give Claude the new
  connector URL.
- **Where things are stored.** The Withings client secret and the access key
  are Worker secrets, and the Withings tokens sit in a KV namespace, all in
  your Cloudflare account. The worker stores nothing else and talks only to
  the Withings API. The local server keeps its tokens in `tokens.json`.
- **What Claude sees.** Tool results become part of your conversation with
  Claude and are handled like anything else you share there.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## How logins work

Withings access tokens last 3 hours; refresh tokens last a year and change on
every refresh. Both servers refresh on their own, five minutes before
expiry. If a refresh fails (access revoked, client secret renewed), the tools
answer with how to log in again: the login link for the remote server, the
`withings_auth.py` command for the local one.

Because every refresh replaces the refresh token, two servers can't share one
login: the first refresh breaks the other. To move a login from the local
server to the worker, run this in `worker/` and then stop using the local
server:

```bash
npm run setup -- --import-tokens ../tokens.json
```

## Development

```bash
cd worker
cp .dev.vars.example .dev.vars    # then fill it in (on Windows: copy)
npm run dev                       # serves http://localhost:8787
npm run typecheck
npm run setup -- --dry-run        # checks the settings and builds without deploying
```

The local MCP endpoint is `http://localhost:8787/mcp/<ACCESS_KEY from .dev.vars>`;
try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`). Withings can't redirect to
`localhost`, so test the login flow on a deployed worker.

## Troubleshooting

- **Setup says you are not logged in to Cloudflare**: run `npx wrangler login`.
  If you have several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` first.
- **"You need to register a workers.dev subdomain"**: accept the prompt when
  setup asks, or open **Workers & Pages** in the Cloudflare dashboard once.
- **`invalid redirect_uri` or status 503 at login**: the callback URL in your
  Withings app doesn't match exactly. For the worker it is the `callback_url`
  in `deploy-output.json`; for the local server it is `WITHINGS_REDIRECT_URI`
  in `.env`.
- **`invalid code` during the local login**: the 30-second code expired. Run
  `python withings_auth.py` again and copy the address sooner.
- **"No Withings login saved yet"**: open the login link (ask Claude to run
  `withings_auth_status` to see it) or, for the local server, run
  `python withings_auth.py`.
- **Logs**: `npx wrangler tail` in `worker/` streams the worker's logs. The
  local server logs to stderr, which Claude Code shows in its MCP server log.

## Project layout

| Path | Purpose |
| --- | --- |
| `worker/src/index.ts` | Worker routes, OAuth login and callback, the six MCP tools. |
| `worker/src/withings.ts` | Withings API client, token storage in KV, weigh-in parsing. |
| `worker/scripts/setup.mjs` | Deploys to your Cloudflare account (`npm run setup`). |
| `worker/wrangler.jsonc` | Worker configuration. |
| `server.py` | Local MCP server (stdio). |
| `withings_client.py` | Local API client: settings, token refresh, measurement parsing. |
| `withings_auth.py` | One-time login for the local server. |

The worker answers every MCP request statelessly from one shared Durable
Object that writes nothing to storage, which keeps it well inside the
Cloudflare free plan.

## License

[MIT](LICENSE). Withings is a trademark of its owner; this project is not
affiliated with Withings.
