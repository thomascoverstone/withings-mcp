#!/usr/bin/env python3
"""
One-time Withings login for the MCP server.

Opens the Withings consent page, captures the OAuth redirect, exchanges the
(30-second!) authorization code for tokens and stores them in tokens.json.
After that the MCP server refreshes the tokens on its own.

Usage (with the project's virtual environment active):
    python withings_auth.py [--no-browser] [--timeout SECONDS]

Withings only accepts HTTPS callback URLs on port 443 (no localhost, no IPs),
so the redirect cannot be caught by a local web server.  Instead the browser
lands on the registered callback URL with ?code=...&state=... in the address
bar (the page itself shows a JSON error - that is expected).  You copy that
address and this script picks it up from the clipboard (Windows, macOS, and
Linux with wl-paste, xclip or xsel), or you paste it into the terminal.
Either way it exchanges the code immediately.

If WITHINGS_REDIRECT_URI ever points at localhost (not allowed by Withings at
the time of writing) the script falls back to a local redirect catcher.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import secrets
import shutil
import subprocess
import sys
import threading
import webbrowser
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import withings_client as wc

LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}

PAGE = """<!doctype html><meta charset="utf-8"><title>{title}</title>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:34rem;text-align:center">
<h1>{title}</h1><p>{detail}</p></body>"""


def say(msg: str = "") -> None:
    print(msg, flush=True)


def parse_redirect(raw: str) -> dict[str, str]:
    """Accept a full redirected URL, a bare query string, or a bare code."""
    raw = raw.strip().strip('"').strip("'")
    if "://" in raw or "?" in raw:
        query = urlparse(raw).query if "://" in raw else raw.split("?", 1)[-1]
        return {k: v[0] for k, v in parse_qs(query).items()}
    if raw.startswith("code="):
        return {k: v[0] for k, v in parse_qs(raw).items()}
    return {"code": raw}


# --------------------------------------------------------------------------
# clipboard
# --------------------------------------------------------------------------

def _read_windows_clipboard() -> str | None:
    import ctypes  # only needed (and only usable this way) on Windows

    CF_UNICODETEXT = 13
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.GetClipboardData.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    if not user32.OpenClipboard(None):
        return None
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _command_reader(cmd: list[str]) -> Callable[[], str | None]:
    def read() -> str | None:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=2, check=False)
        return result.stdout if result.returncode == 0 else None

    return read


def clipboard_reader() -> Callable[[], str | None] | None:
    """A function that returns the clipboard text, or None when this system offers no way to read it."""
    if sys.platform == "win32":
        return _read_windows_clipboard
    candidates: list[list[str]] = []
    if sys.platform == "darwin":
        candidates.append(["pbpaste"])
    else:
        if os.environ.get("WAYLAND_DISPLAY"):
            candidates.append(["wl-paste", "--no-newline"])
        if os.environ.get("DISPLAY"):
            candidates += [["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]]
    for cmd in candidates:
        if shutil.which(cmd[0]):
            return _command_reader(cmd)
    return None


def wait_for_copied_or_pasted_redirect(timeout: float) -> dict[str, str]:
    """
    Race two sources: the clipboard (user copied the address bar in the
    browser) and stdin (user pasted the URL and pressed Enter).
    """
    read_clipboard = clipboard_reader()
    mod = "Cmd" if sys.platform == "darwin" else "Ctrl"
    say("After you click Allow, the browser lands on a page that shows an error.")
    say("That is expected. The code is in the ADDRESS BAR. Do one of these, fast:")
    if read_clipboard:
        say(f"  * Click the address bar ({mod}+L) and copy it ({mod}+C). I am watching the clipboard.")
        say("  * Or paste the full address here and press Enter.")
    else:
        say("  * Copy the full address from the address bar, paste it here and press Enter.")
    say("Withings codes expire 30 seconds after the redirect.")
    say()

    found: dict[str, str] = {}
    done = threading.Event()

    def looks_like_redirect(text: str) -> bool:
        return "code=" in text and (
            text.startswith(wc.REDIRECT_URI.split("?")[0]) or text.startswith("http")
        )

    def watch_clipboard() -> None:
        if read_clipboard is None:
            return  # no clipboard access here; stdin still works
        try:
            baseline = read_clipboard()
        except Exception:  # noqa: BLE001
            return  # clipboard unavailable; stdin still works
        while not done.wait(0.3):
            try:
                text = read_clipboard()
            except Exception:  # noqa: BLE001
                continue
            if text and text != baseline and looks_like_redirect(text.strip()):
                found.update(parse_redirect(text))
                found["_via"] = "clipboard"
                done.set()
                return

    def watch_stdin() -> None:
        try:
            raw = input("> ")
        except EOFError:
            return
        if raw.strip() and not done.is_set():
            found.update(parse_redirect(raw))
            found["_via"] = "paste"
            done.set()

    threading.Thread(target=watch_clipboard, daemon=True).start()
    threading.Thread(target=watch_stdin, daemon=True).start()
    if not done.wait(timeout):
        raise SystemExit(
            f"Timed out after {int(timeout)}s waiting for the redirect URL. "
            "Run the script again and finish the login in the browser."
        )
    via = found.pop("_via", "?")
    say(f"Got the redirect ({via}).")
    return found


# --------------------------------------------------------------------------
# local redirect catcher (only usable if Withings ever allows localhost)
# --------------------------------------------------------------------------

class _CallbackServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, addr: tuple[str, int]):
        super().__init__(addr, _CallbackHandler)
        self.result: dict[str, str] | None = None
        self.done = threading.Event()


class _CallbackHandler(BaseHTTPRequestHandler):
    server: _CallbackServer  # type: ignore[assignment]

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        query = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        if "code" in query or "error" in query:
            self.server.result = query
            if "code" in query:
                self._send(200, PAGE.format(
                    title="Withings connected",
                    detail="You can close this tab and go back to the terminal."))
            else:
                self._send(400, PAGE.format(
                    title="Withings login failed",
                    detail=query.get("error_description") or query.get("error", "")))
            self.server.done.set()
        else:
            self._send(404, PAGE.format(
                title="Waiting for Withings",
                detail="This page only handles the OAuth redirect."))

    def _send(self, status: int, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:  # silence request logging
        pass


def wait_for_local_redirect(host: str, port: int, timeout: float) -> dict[str, str]:
    bind_host = "127.0.0.1" if host == "localhost" else host
    try:
        server = _CallbackServer((bind_host, port))
    except OSError as exc:
        raise SystemExit(
            f"Could not listen on {bind_host}:{port} ({exc}).\n"
            "Close whatever is using that port, or pick another port in both "
            "WITHINGS_REDIRECT_URI (.env) and the dashboard Callback URL."
        ) from exc
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        if not server.done.wait(timeout):
            raise SystemExit(
                f"Timed out after {int(timeout)}s waiting for the Withings redirect. "
                "Run the script again and finish the login in the browser."
            )
        return server.result or {}
    finally:
        server.shutdown()
        server.server_close()


# --------------------------------------------------------------------------
# main flow
# --------------------------------------------------------------------------

async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Log the Withings MCP server in to your account.")
    ap.add_argument("--no-browser", action="store_true", help="print the URL instead of opening a browser")
    ap.add_argument("--timeout", type=float, default=300, help="seconds to wait for the redirect (default 300)")
    args = ap.parse_args(argv)

    try:
        wc.require_config()
    except wc.WithingsError as exc:
        say(f"ERROR: {exc}")
        return 2

    redirect = urlparse(wc.REDIRECT_URI)
    local = (redirect.hostname or "").lower() in LOCAL_HOSTS
    port = redirect.port or (443 if redirect.scheme == "https" else 80)
    state = secrets.token_urlsafe(24)
    url = wc.WithingsClient.authorize_url(state)

    say("Withings login")
    say("==============")
    say(f"Client ID    : {wc.CLIENT_ID[:8]}...{wc.CLIENT_ID[-4:]}")
    say(f"Redirect URI : {wc.REDIRECT_URI}")
    say(f"Scope        : {wc.SCOPE}")
    say(f"Token file   : {wc.TOKEN_FILE}")
    say()
    say("The Callback URL on developer.withings.com must be EXACTLY the redirect URI above.")
    say()
    if local:
        say(f"Listening on http://{redirect.hostname}:{port} for the redirect...")
    say("Opening your browser. If nothing opens, paste this URL into a browser yourself:")
    say()
    say(url)
    say()
    if not args.no_browser:
        webbrowser.open(url)

    if local:
        result = await asyncio.to_thread(
            wait_for_local_redirect, redirect.hostname or "localhost", port, args.timeout)
    else:
        result = await asyncio.to_thread(wait_for_copied_or_pasted_redirect, args.timeout)

    if "error" in result:
        say(f"Withings returned an error: {result.get('error')} {result.get('error_description', '')}")
        return 1
    code = result.get("code")
    if not code:
        say("No authorization code found in what was copied/pasted.")
        return 1
    if "state" in result and result["state"] != state:
        say("The 'state' value in the redirect does not match this run. Aborting; run the script again.")
        return 1
    if "state" not in result:
        say("(No state value to verify - continuing.)")

    client = wc.WithingsClient()
    try:
        say("Exchanging the code for tokens...")
        tokens = await client.exchange_code(code)
        say(f"Saved tokens for Withings user {tokens['userid']} -> {wc.TOKEN_FILE}")
        say(f"Granted scope: {tokens['scope'] or '(not reported)'}")

        say("Running a live check against your account...")
        now = datetime.now(timezone.utc)
        groups, tz = await client.measure_groups(
            start=now - timedelta(days=365), end=now, types=[1, 6, 76])
        sessions = wc.build_sessions(groups, tz)
        if sessions:
            latest = sessions[0]
            w = latest["metrics"].get("weight", {})
            say(f"Live check OK: latest weigh-in {latest['time']} - "
                f"{w.get('value')} kg / {w.get('lb')} lb "
                f"({len(sessions)} sessions in the last year, timezone {tz}).")
        else:
            say("Live check OK, but no weight measurements were found in the last year.")
    except wc.WithingsError as exc:
        say(f"ERROR: {exc}")
        if "code" in str(exc).lower():
            say("The 30-second code most likely expired. Run the script again and copy faster.")
        return 1
    finally:
        await client.aclose()

    say()
    say("Done. Start a new Claude session and ask something like:")
    say('  "What did I weigh this morning?"')
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    sys.exit(asyncio.run(main(sys.argv[1:])))
