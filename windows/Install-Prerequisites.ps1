$ErrorActionPreference = "Stop"

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$machine;$user;$env:PATH"
}

function Ensure-Command([string]$Command, [string]$WingetId) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Missing $Command and winget is not available. Install $Command manually, then run ChatGPT To Codex again."
    }
    Write-Host "[chatgpt2codex] installing $Command via winget..."
    winget install --id $WingetId --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was installed but is not on PATH yet. Open a new PowerShell window and run ChatGPT To Codex again."
    }
}

function Assert-NodeVersion {
    $version = (& node -p "process.versions.node").Trim().Split('.')
    $major = [int]$version[0]
    $minor = [int]$version[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 16)) {
        throw "Node.js 22.16.0 or newer is required; found $(& node -v). Upgrade Node.js, then run ChatGPT To Codex again."
    }
}

Ensure-Command node "OpenJS.NodeJS.LTS"
Assert-NodeVersion
Ensure-Command cloudflared "Cloudflare.cloudflared"
