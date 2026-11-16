"""
Point Claude Code at the remote Withings MCP worker and remove the local
stdio entry from the Claude Desktop config (the claude.ai custom connector
replaces it there).  Called by deploy.ps1; safe to run by hand:

    ..\\.venv\\Scripts\\python.exe update_claude_configs.py https://<worker>/mcp/<key>
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path


def main(mcp_url: str) -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")

    # Claude Code, user scope
    cc = Path.home() / ".claude.json"
    if cc.exists():
        shutil.copy2(cc, cc.with_name(f".claude.json.bak-{stamp}"))
        data = json.loads(cc.read_text(encoding="utf-8"))
        data.setdefault("mcpServers", {})["withings"] = {"type": "http", "url": mcp_url}
        cc.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  Claude Code: mcpServers.withings -> {mcp_url}")
    else:
        print(f"  Claude Code config not found at {cc}; skipped")

    # Claude Desktop (chat): drop the local stdio server so it cannot fight
    # the worker over the rotating refresh token.
    appdata = os.environ.get("APPDATA")
    if appdata:
        cd = Path(appdata) / "Claude" / "claude_desktop_config.json"
        if cd.exists():
            data = json.loads(cd.read_text(encoding="utf-8"))
            if "withings" in data.get("mcpServers", {}):
                shutil.copy2(cd, cd.with_name(f"claude_desktop_config.json.bak-{stamp}"))
                del data["mcpServers"]["withings"]
                cd.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
                print("  Claude Desktop: removed local 'withings' stdio entry (use the custom connector instead)")
            else:
                print("  Claude Desktop: no local 'withings' entry to remove")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        print("usage: update_claude_configs.py https://<worker>/mcp/<access-key>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
