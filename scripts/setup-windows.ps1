param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,
    [string]$InstallDir = (Join-Path $HOME "ChatGPT To Codex\chatgpt2codex"),
    [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Ensure-Command([string]$Command, [string]$WingetId) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Missing $Command and winget is not available. Install $Command, then rerun this script."
    }
    Write-Host "[chatgpt2codex] installing $Command via winget..."
    winget install --id $WingetId --silent --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was installed but is not on PATH yet. Open a new PowerShell window and rerun this script."
    }
}

function Assert-NodeVersion {
    $version = (& node -p "process.versions.node").Trim().Split('.')
    $major = [int]$version[0]
    $minor = [int]$version[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 16)) {
        throw "Node.js 22.16.0 or newer is required; found $(& node -v). Upgrade Node.js, then rerun this script."
    }
}

Ensure-Command git "Git.Git"
Ensure-Command node "OpenJS.NodeJS.LTS"
Ensure-Command npm "OpenJS.NodeJS.LTS"
Assert-NodeVersion
Ensure-Command cloudflared "Cloudflare.cloudflared"

$parent = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Force -Path $parent | Out-Null

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "[chatgpt2codex] updating existing checkout..."
    git -C $InstallDir pull --ff-only
} elseif (Test-Path $InstallDir) {
    throw "InstallDir already exists and is not a git checkout: $InstallDir"
} else {
    Write-Host "[chatgpt2codex] cloning $RepoUrl..."
    git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir
npm install
npm run build
if (Test-Path (Join-Path $InstallDir "windows\Build-ChatGPTToCodexExe.ps1")) {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir "windows\Build-ChatGPTToCodexExe.ps1")
}

$shortcutDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcutPath = Join-Path $shortcutDir "ChatGPT To Codex.lnk"
$exeTarget = Join-Path $InstallDir "ChatGPT To Codex.exe"
$target = if (Test-Path $exeTarget) { $exeTarget } else { Join-Path $InstallDir "windows\Start-ChatGPTToCodexTray.cmd" }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = "ChatGPT To Codex tray controller"
$shortcut.Save()

Write-Host "[chatgpt2codex] ready."
Write-Host "[chatgpt2codex] Start Menu shortcut: $shortcutPath"
Write-Host "[chatgpt2codex] Tray launcher: $target"

if ($Launch) {
    Start-Process $target
}
