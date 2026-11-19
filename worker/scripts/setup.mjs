#!/usr/bin/env node
// Deploys this MCP server to your own Cloudflare account and prints the URLs to use.
// Works on Windows, macOS and Linux. Run it from the worker folder:
//
//   npm run setup                         first deploy, and every redeploy after a change
//   npm run setup -- --rotate-key         new ACCESS_KEY: the old connector URL and login link stop working
//   npm run setup -- --url https://host   the worker's public URL, when it is not on workers.dev
//   npm run setup -- --import-tokens ../tokens.json
//                                         reuse a login made with the local Python server
//   npm run setup -- --dry-run            check the setup and bundle the worker without deploying
//
// Reads WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET from the environment or from ../.env, and writes
// deploy-output.json next to package.json (git-ignored). That file holds your ACCESS_KEY; later runs
// reuse it, so keep it (copy it along to redeploy from another computer).

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PROJECT = {
  title: "Withings",
  serverName: "withings",
  credentials: ["WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET"],
  /** KV key the worker keeps its login under (for --import-tokens). */
  tokenKey: "withings:tokens",
  checkCredentials: () => {},
  providerSteps: (out) => [
    ["In your Withings developer app (developer.withings.com), add this callback URL:", out.callback_url],
    ["Log in to Withings once by opening this link in a browser:", out.login_url],
  ],
};

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(WORKER_DIR, "..");
const OUTPUT_FILE = join(WORKER_DIR, "deploy-output.json");
const WRANGLER = join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

const USAGE = `Usage: npm run setup -- [options]

  --dry-run               check the setup and bundle the worker without deploying
  --rotate-key            generate a new ACCESS_KEY (the old connector URL stops working)
  --url <https://...>     the worker's public URL, if it is not served on workers.dev
  --import-tokens <file>  upload a tokens.json saved by the local Python server
  -h, --help              show this help`;

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

/** Minimal .env reader: KEY=value lines, optional quotes, # comments. */
function readDotEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(["']).*\1$/.test(m[2]);
    values[m[1]] = quoted ? m[2].slice(1, -1) : m[2].replace(/\s+#.*$/, "");
  }
  return values;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Run the project's own wrangler (no shell, so paths and values need no quoting). */
function wrangler(args, { input, capture = false, env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: WORKER_DIR,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    let out = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (out += d));
    }
    if (input !== undefined) child.stdin.end(input);
    child.on("error", (err) => done({ code: 1, out: String(err) }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** Same derivation as loginKey() in src/: HMAC-SHA256(ACCESS_KEY, "login-link-v1"), 24 bytes, base64url. */
function loginKey(accessKey) {
  return createHmac("sha256", accessKey).update("login-link-v1").digest().subarray(0, 24).toString("base64url");
}

/** The worker's public URL, from the machine-readable record wrangler writes during a deploy. */
function deployedUrl(recordFile) {
  if (!existsSync(recordFile)) return undefined;
  const targets = readFileSync(recordFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.type === "deploy" ? (entry.targets ?? []) : [];
      } catch {
        return [];
      }
    });
  const url =
    targets.find((t) => /^https:\/\/[^/\s]+\.workers\.dev\/?$/.test(t)) ??
    targets.find((t) => /^https:\/\/[^/\s]+\/?$/.test(t));
  return url?.replace(/\/+$/, "");
}

async function main() {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        "rotate-key": { type: "boolean", default: false },
        url: { type: "string" },
        "import-tokens": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const dryRun = opts["dry-run"];

  // ---- prerequisites ---------------------------------------------------------------
  if (Number(process.versions.node.split(".")[0]) < 22) fail(`Node.js 22 or newer is required (this is ${process.version}).`);
  if (!existsSync(WRANGLER)) fail("wrangler is not installed here yet. Run `npm install` in this folder first.");

  const dotenv = readDotEnv(join(REPO_DIR, ".env"));
  const credentials = {};
  for (const name of PROJECT.credentials) {
    const value = (process.env[name] || dotenv[name] || "").trim();
    if (!value) fail(`${name} is not set. Copy .env.example to .env in ${REPO_DIR} and fill it in (or set it in the environment).`);
    if (/^your-|your-client/i.test(value)) fail(`${name} still has the placeholder value from .env.example.`);
    credentials[name] = value;
  }
  PROJECT.checkCredentials(credentials);

  let url;
  if (opts.url !== undefined) {
    let parsed;
    try {
      parsed = new URL(opts.url);
    } catch {
      fail(`--url must be a full URL such as https://mcp.example.com (got "${opts.url}").`);
    }
    if (parsed.protocol !== "https:") fail("--url must start with https://.");
    url = parsed.origin;
  }

  let tokensFile;
  if (opts["import-tokens"] !== undefined) {
    tokensFile = resolve(process.env.INIT_CWD || process.cwd(), opts["import-tokens"]);
    const tokens = readJson(tokensFile);
    if (!tokens?.access_token || !tokens?.refresh_token) fail(`${tokensFile} is not a tokens file with access_token and refresh_token.`);
  }

  // ---- access key: reuse the one from the last deploy unless asked to rotate ------------
  const previous = readJson(OUTPUT_FILE);
  let accessKey = previous?.access_key;
  let keyNote = "kept from deploy-output.json, so the connector URL is unchanged";
  if (opts["rotate-key"] || !accessKey) {
    accessKey = randomBytes(24).toString("base64url");
    keyNote = opts["rotate-key"] && previous?.access_key ? "rotated: the old connector URL and login link stop working" : "new";
  } else if (!/^[A-Za-z0-9_-]{24,}$/.test(accessKey)) {
    fail(`The access_key in ${OUTPUT_FILE} is not a valid key. Fix it, or run again with --rotate-key.`);
  }

  // ---- Cloudflare login ---------------------------------------------------------------
  if (!dryRun) {
    step("Checking the Cloudflare login");
    const who = await wrangler(["whoami"], { capture: true });
    if (who.code !== 0 || !/You are logged in/i.test(who.out)) {
      fail("Not logged in to Cloudflare. Run `npx wrangler login` (it opens a browser), then run this again.");
    }
    console.log("Logged in.");
  }

  // ---- deploy -------------------------------------------------------------------------
  if (dryRun) {
    step("Bundling the worker (dry run: nothing is uploaded)");
    const r = await wrangler(["deploy", "--dry-run"]);
    if (r.code !== 0) fail("The dry-run build failed; see wrangler's output above.");
  } else {
    step("Deploying the worker");
    const record = join(tmpdir(), `wrangler-deploy-${process.pid}-${Date.now()}.ndjson`);
    let r;
    try {
      r = await wrangler(["deploy"], { env: { WRANGLER_OUTPUT_FILE_PATH: record } });
      url ??= deployedUrl(record);
    } finally {
      rmSync(record, { force: true });
    }
    if (r.code !== 0) fail("wrangler deploy failed; see its output above.");
  }

  // ---- secrets ------------------------------------------------------------------------
  const secretNames = [...Object.keys(credentials), "ACCESS_KEY"].join(", ");
  if (dryRun) {
    step(`Would upload the secrets ${secretNames} (ACCESS_KEY: ${keyNote})`);
  } else {
    step(`Uploading the secrets ${secretNames} (ACCESS_KEY: ${keyNote})`);
    const r = await wrangler(["secret", "bulk"], { input: JSON.stringify({ ...credentials, ACCESS_KEY: accessKey }) });
    if (r.code !== 0) fail("Uploading the secrets failed; see wrangler's output above.");
  }

  // ---- saved login (optional) ------------------------------------------------------------
  if (tokensFile) {
    if (dryRun) {
      step(`Would import the saved login from ${tokensFile}`);
    } else {
      step(`Importing the saved login from ${tokensFile}`);
      const r = await wrangler(["kv", "key", "put", PROJECT.tokenKey, "--path", tokensFile, "--binding", "TOKENS", "--remote"]);
      if (r.code !== 0) fail("Importing the login failed; see wrangler's output above.");
      console.log("Done. The worker refreshes this login from now on, so stop using that tokens.json elsewhere.");
    }
  }

  if (dryRun) {
    console.log("\nDry run finished: the settings are complete and the worker builds.");
    return;
  }

  // ---- results ----------------------------------------------------------------------
  const out = {
    url: url ?? null,
    access_key: accessKey,
    mcp_url: url ? `${url}/mcp/${accessKey}` : null,
    login_url: url ? `${url}/auth/${loginKey(accessKey)}` : null,
    callback_url: url ? `${url}/callback` : null,
    deployed_at: new Date().toISOString(),
  };
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(OUTPUT_FILE, 0o600);
  } catch {
    /* not supported on every file system */
  }
  if (!url) {
    fail(
      "Deployed, but wrangler reported no https URL for the worker (is it on custom routes only?).\n" +
        "Run this again with --url https://<the worker's public host> to get the connector and login links.",
    );
  }

  const steps = [
    ...PROJECT.providerSteps(out),
    [
      "Add the connector URL to Claude:",
      "claude.ai, Claude Desktop and the mobile apps: Settings > Connectors > Add custom connector",
      `Claude Code: claude mcp add --transport http --scope user ${PROJECT.serverName} ${out.mcp_url}`,
    ],
  ];
  console.log("\n================ Done ================");
  console.log(`\nConnector URL (treat it like a password: anyone who has it can read your ${PROJECT.title} data):`);
  console.log(`    ${out.mcp_url}`);
  console.log("\nIf you have not done these yet:");
  steps.forEach(([text, ...details], i) => {
    console.log(`  ${i + 1}. ${text}`);
    for (const detail of details) console.log(`       ${detail}`);
  });
  console.log(`\nSaved to ${OUTPUT_FILE} (git-ignored; keep it private).`);
}

await main();
