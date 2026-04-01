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
    "options.js",
    "shared\constants.js",
    "shared\utils.js",
    "icon_notify.png"
)

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$encoded    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${User}:${Pass}"))
$authHeader = @{ "Authorization" = "Basic $encoded" }

# -- Step 1: Sync extension files --
$codeBase = if ($CodeUrl.EndsWith("/")) { $CodeUrl } else { "$CodeUrl/" }
$Global:CreatedDirs = New-Object System.Collections.Generic.HashSet[string]
Write-Host "Syncing extension files to WebDAV..."

foreach ($file in $SyncFiles) {
    $localPath = Join-Path $scriptDir $file
    if (-not (Test-Path $localPath)) {
        Write-Warning "  Skip (not found): $file"
        continue
    }
    
    # 自动创建远程目录 (WebDAV MKCOL)
    $dirPart = Split-Path $file
    if ($dirPart) {
        # 兼容多种路径分隔符
        $subDirs = $dirPart -split '[\\/]' | Where-Object { $_ }
        $currentPath = $codeBase.TrimEnd('/')
        foreach ($sub in $subDirs) {
            # 目录请求通常建议带上末尾斜杠
            $currentPath += "/$sub/"
            if (-not $Global:CreatedDirs.Contains($currentPath)) {
                try {
                    Write-Host "  MKCOL $sub ..." -ForegroundColor Cyan
                    # 使用 .NET 原生方法以避开 PowerShell 5.1 对 Method 枚举的限制
                    $req = [System.Net.HttpWebRequest]::Create($currentPath)
                    $req.Method = "MKCOL"
                    $req.Headers.Add("Authorization", $authHeader.Authorization)
                    $resp = $req.GetResponse()
                    $resp.Close()
                } catch {
                    # 获取状态码，注意 Response 可能为空
                    $status = -1
                    if ($_.Exception.InnerException -and $_.Exception.InnerException.Response) {
                        $status = [int]$_.Exception.InnerException.Response.StatusCode
                    } elseif ($_.Exception.Response) {
                        $status = [int]$_.Exception.Response.StatusCode
                    }
                    
                    # 405 (Method Not Allowed) 通常表示目录已存在
                    if ($status -ne 405 -and $status -ne 201 -and $status -ne 200) {
                        Write-Warning "  MKCOL $sub notice: Status $status ($($_.Exception.Message))"
                    }
                }
                $Global:CreatedDirs.Add($currentPath) | Out-Null
            }
        }
    }

    $remoteUrl = $codeBase + ($file -replace '\\', '/')
    Write-Host "  PUT -> $remoteUrl" -ForegroundColor Gray
    try {
        $fileBytes = [System.IO.File]::ReadAllBytes($localPath)
        $response = Invoke-WebRequest -Uri $remoteUrl -Method PUT -Body $fileBytes `
            -Headers ($authHeader + @{ "Content-Type" = "application/octet-stream" }) `
            -UseBasicParsing
        Write-Host "  OK  $file (Code: $($response.StatusCode))"
    } catch {
        Write-Warning "  FAIL $file  $($_.Exception.Message)"
    }
}

# -- Step 2: Update version.json to trigger hot-reload --
$ts          = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$versionBase = if ($VersionUrl.EndsWith("/")) { $VersionUrl } else { "$VersionUrl/" }
try {
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes("{`"version`": $ts}")
    $vUrl      = "${versionBase}version.json"
    $response  = Invoke-WebRequest -Uri $vUrl -Method PUT -Body $bodyBytes `
        -Headers ($authHeader + @{ "Content-Type" = "application/json" }) `
        -UseBasicParsing
    Write-Host "`nDone. version = $ts (Code: $($response.StatusCode))"
} catch {
    Write-Error "Failed to update version.json: $_"
}
