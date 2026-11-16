# deploy.ps1 - one-shot deploy of the Withings MCP worker to Cloudflare.
#
# Prerequisite (do once, it opens a browser):   npx wrangler login
# Then:                                          powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# What it does:
#   1. creates the TOKENS KV namespace on first run and writes its id into wrangler.jsonc
#   2. deploys the worker and reads back its https://*.workers.dev URL
#   3. uploads the secrets (Withings client id/secret from ..\.env, plus a random ACCESS_KEY)
#   4. seeds the worker with the tokens from ..\tokens.json if the local login was done
#   5. writes deploy-output.json (URL, key, connector URL, login URL, callback URL)
#   6. repoints Claude Code at the remote server and removes the local desktop entry
$ErrorActionPreference = "Stop"
# Native commands run via cmd /c with 2>&1 inside cmd: PowerShell 5.1 would otherwise turn
# harmless stderr lines (e.g. "npm notice") into terminating errors under Stop.
Set-Location $PSScriptRoot
$root = Split-Path $PSScriptRoot -Parent
$py = Join-Path $root ".venv\Scripts\python.exe"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# ---- 0. logged in? ---------------------------------------------------------
Step "Checking wrangler login"
$who = (cmd /c "npx wrangler whoami 2>&1") | Out-String
if ($who -notmatch "logged in") {
    Write-Host $who
    Write-Host "Not logged in to Cloudflare. Run:  npx wrangler login   (opens a browser), then re-run this script." -ForegroundColor Yellow
    exit 1
}
Write-Host ($who.Trim().Split("`n") | Where-Object { $_ -match "logged in" } | Select-Object -First 1)

# ---- 1. KV namespace -------------------------------------------------------
$cfg = Get-Content wrangler.jsonc -Raw
if ($cfg -match "REPLACE_WITH_KV_ID") {
    Step "Creating KV namespace TOKENS"
    $out = (cmd /c "npx wrangler kv namespace create TOKENS 2>&1") | Out-String
    if ($out -match '"id":\s*"([0-9a-f]{32})"') {
        $kvId = $Matches[1]
    } elseif ($out -match 'id\s*=\s*"([0-9a-f]{32})"') {
        $kvId = $Matches[1]
    } else {
        Write-Host $out
        throw "Could not find the KV namespace id in wrangler's output."
    }
    $cfg = $cfg -replace "REPLACE_WITH_KV_ID", $kvId
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "wrangler.jsonc"), $cfg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "KV namespace id: $kvId"
} else {
    Write-Host "KV namespace already configured."
}

# ---- 2. deploy -------------------------------------------------------------
Step "Deploying worker"
$deploy = (cmd /c "npx wrangler deploy 2>&1") | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $deploy; throw "wrangler deploy failed" }
Write-Host $deploy
if ($deploy -match 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev') {
    $url = $Matches[0]
} else {
    throw "Could not find the workers.dev URL in the deploy output above."
}
Write-Host "Worker URL: $url"

# ---- 3. secrets ------------------------------------------------------------
Step "Uploading secrets"
$outFile = Join-Path $PSScriptRoot "deploy-output.json"
$accessKey = $null
if (Test-Path $outFile) {
    try { $accessKey = (Get-Content $outFile -Raw | ConvertFrom-Json).access_key } catch { $accessKey = $null }
}
if (-not $accessKey) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $accessKey = ([Convert]::ToBase64String($bytes)) -replace '\+', '-' -replace '/', '_' -replace '=', ''
}
$envMap = @{}
Get-Content (Join-Path $root ".env") | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $envMap[$Matches[1]] = $Matches[2] }
}
if (-not $envMap["WITHINGS_CLIENT_ID"] -or -not $envMap["WITHINGS_CLIENT_SECRET"]) {
    throw "WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET missing from $root\.env"
}
$secrets = @(
    @("WITHINGS_CLIENT_ID", $envMap["WITHINGS_CLIENT_ID"]),
    @("WITHINGS_CLIENT_SECRET", $envMap["WITHINGS_CLIENT_SECRET"]),
    @("ACCESS_KEY", $accessKey)
)
foreach ($s in $secrets) {
    $name = $s[0]; $value = $s[1]
    $tmp = Join-Path $env:TEMP ("wr-secret-" + [guid]::NewGuid().ToString("n"))
    [System.IO.File]::WriteAllText($tmp, $value, (New-Object System.Text.UTF8Encoding $false))
    try {
        $r = (cmd /c "npx wrangler secret put $name < `"$tmp`" 2>&1") | Out-String
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) { Write-Host $r; throw "wrangler secret put $name failed" }
    Write-Host "  set $name"
}

# ---- 4. seed tokens --------------------------------------------------------
$tokens = Join-Path $root "tokens.json"
if (Test-Path $tokens) {
    Step "Seeding the worker with your existing Withings login (tokens.json)"
    $r = (cmd /c "npx wrangler kv key put withings:tokens --path `"$tokens`" --binding TOKENS --remote 2>&1") | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host $r; throw "seeding tokens failed" }
    Write-Host "  done. The worker now owns the token refresh; do not run the local Python server any more."
} else {
    Step "No local tokens.json found - you will log in through the worker instead"
}

# ---- 5. record outputs -----------------------------------------------------
$mcpUrl = "$url/mcp/$accessKey"
$loginUrl = "$url/auth/$accessKey"
$callbackUrl = "$url/callback"
@{
    url = $url; access_key = $accessKey; mcp_url = $mcpUrl
    login_url = $loginUrl; callback_url = $callbackUrl
    deployed_at = (Get-Date).ToString("s")
} | ConvertTo-Json | Set-Content $outFile -Encoding utf8

# ---- 6. repoint local Claude configs ---------------------------------------
Step "Pointing Claude Code at the remote server (backups are written next to each config)"
$upd = Join-Path $PSScriptRoot "update_claude_configs.py"
$r = (cmd /c "`"$py`" `"$upd`" $mcpUrl 2>&1") | Out-String
Write-Host $r
if ($LASTEXITCODE -ne 0) { throw "updating Claude configs failed" }

# ---- done ------------------------------------------------------------------
Write-Host ""
Write-Host "================ DONE ================" -ForegroundColor Green
Write-Host "MCP connector URL (keep it private, it is your key):"
Write-Host "  $mcpUrl" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. claude.ai (web, desktop chat, phone): Settings > Connectors > Add custom connector"
Write-Host "     Name: Withings    URL: $mcpUrl"
Write-Host "  2. developer.withings.com > your app > Edit > Callback URL:"
Write-Host "     $callbackUrl      (needed only when you log in again via $loginUrl)"
Write-Host "  3. Restart Claude Desktop / start a new Claude Code session."
Write-Host ""
Write-Host "Details saved to $outFile"
