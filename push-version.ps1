# push-version.ps1
# Sync extension files to WebDAV and update version.json to trigger hot-reload
# Config is loaded from .env in the same directory

param(
    [string]$VersionUrl = "",
    [string]$CodeUrl    = "",
    [string]$User       = "",
    [string]$Pass       = ""
)

# -- Load .env --
$envFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match "^\s*[^#]" } | ForEach-Object {
        if ($_ -match "^\s*([^=]+?)\s*=\s*(.*)$") {
            $k = $Matches[1].Trim(); $v = $Matches[2].Trim()
            if (-not (Get-Variable -Name $k -ErrorAction SilentlyContinue)) { Set-Variable -Name $k -Value $v }
            switch ($k) {
                "VERSION_URL"  { if (-not $VersionUrl) { $VersionUrl = $v } }
                "CODE_URL"     { if (-not $CodeUrl)    { $CodeUrl    = $v } }
                "WEBDAV_USER"  { if (-not $User)       { $User       = $v } }
                "WEBDAV_PASS"  { if (-not $Pass)       { $Pass       = $v } }
            }
        }
    }
}

if (-not $VersionUrl) { Write-Error ".env missing VERSION_URL"; exit 1 }
if (-not $CodeUrl)    { Write-Error ".env missing CODE_URL";    exit 1 }

# Files to sync (relative to this script)
$SyncFiles = @(
    "manifest.json",
    "background.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "options.html",
    "options.js"
)

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$encoded    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${User}:${Pass}"))
$authHeader = @{ "Authorization" = "Basic $encoded" }

# -- Step 1: Sync extension files --
$codeBase = if ($CodeUrl.EndsWith("/")) { $CodeUrl } else { "$CodeUrl/" }
Write-Host "Syncing extension files to WebDAV..."

foreach ($file in $SyncFiles) {
    $localPath = Join-Path $scriptDir $file
    if (-not (Test-Path $localPath)) {
        Write-Warning "  Skip (not found): $file"
        continue
    }
    $remoteUrl = $codeBase + $file
    try {
        $fileBytes = [System.IO.File]::ReadAllBytes($localPath)
        Invoke-WebRequest -Uri $remoteUrl -Method PUT -Body $fileBytes `
            -Headers ($authHeader + @{ "Content-Type" = "application/octet-stream" }) `
            -UseBasicParsing | Out-Null
        Write-Host "  OK  $file"
    } catch {
        Write-Warning "  FAIL $file  $_"
    }
}

# -- Step 2: Update version.json to trigger hot-reload --
$ts          = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$versionBase = if ($VersionUrl.EndsWith("/")) { $VersionUrl } else { "$VersionUrl/" }
try {
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes("{`"version`": $ts}")
    Invoke-WebRequest -Uri "${versionBase}version.json" -Method PUT -Body $bodyBytes `
        -Headers ($authHeader + @{ "Content-Type" = "application/json" }) `
        -UseBasicParsing | Out-Null
    Write-Host "`nDone. version = $ts  (remote popup will auto-reload on next open)"
} catch {
    Write-Error "Failed to update version.json: $_"
}
