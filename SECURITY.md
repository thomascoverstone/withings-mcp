# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: on GitHub,
open this repository's **Security** tab and choose **Report a vulnerability**.
This is a personal project, so fixes are made on a best-effort basis, and only
the latest version on `main` is supported.

## How the server is protected

- The MCP endpoint is `/mcp/<ACCESS_KEY>`: the connector URL itself is the
  credential, and the worker compares it in constant time. There is no other
  login for the endpoint, so the URL must stay private.
- The login link, `/auth/<login key>`, uses a key derived from `ACCESS_KEY`
  with HMAC-SHA256. It can start a Withings login but can't read data, and it
  does not reveal `ACCESS_KEY`.
- OAuth `state` values are random, single-use and expire after 10 minutes.
- The Withings client secret and `ACCESS_KEY` are Worker secrets. Tokens are
  stored in a KV namespace in the deployer's own Cloudflare account.
- The local Python server talks to Claude over stdio only. It writes
  `tokens.json` atomically, readable only by your user on macOS and Linux.
- All tools are read-only.

The README's Security section explains how to keep the links private and how
to rotate the key.
