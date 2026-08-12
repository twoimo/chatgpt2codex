#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' "error: the GitHub PR feedback supervisor launchd service requires macOS." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.ezbuilder.chatgpt2codex.github-pr-feedback-supervisor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${CHATGPT2CODEX_STATE_DIR:-$HOME/.local/share/chatgpt2codex}"
WORKSPACE="${CHATGPT2CODEX_WORKSPACE:-$ROOT}"
NODE="${CHATGPT2CODEX_NODE:-$(command -v node || true)}"
ALLOWLIST="${CHATGPT2CODEX_GITHUB_PR_ALLOWLIST:-}"
CDP_URL="${CHATGPT2CODEX_CHATGPT_CDP_URL:-http://127.0.0.1:9229}"
INTERVAL_SECONDS="${CHATGPT2CODEX_SUPERVISOR_INTERVAL_SECONDS:-300}"
DURATION_HOURS="${CHATGPT2CODEX_SUPERVISOR_DURATION_HOURS:-168}"
RESET_WINDOW="${CHATGPT2CODEX_RESET_UNATTENDED_WINDOW:-1}"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  printf '%s\n' "error: a usable Node.js executable is required." >&2
  exit 1
fi
if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  printf '%s\n' "error: $ROOT/dist/cli.js is missing; run npm run build before installing the service." >&2
  exit 1
fi
if [[ ! "$INTERVAL_SECONDS" =~ ^[0-9]+$ || "$INTERVAL_SECONDS" -lt 60 || "$INTERVAL_SECONDS" -gt 86400 ]]; then
  printf '%s\n' "error: interval must be between 60 and 86400 seconds." >&2
  exit 1
fi
if [[ ! "$DURATION_HOURS" =~ ^[0-9]+$ || "$DURATION_HOURS" -lt 1 || "$DURATION_HOURS" -gt 168 ]]; then
  printf '%s\n' "error: duration must be between 1 and 168 hours (7 days)." >&2
  exit 1
fi
if [[ "$CDP_URL" != "http://127.0.0.1:"* && "$CDP_URL" != "http://localhost:"* && "$CDP_URL" != "http://[::1]:"* ]]; then
  printf '%s\n' "error: ChatGPT CDP URL must be loopback HTTP." >&2
  exit 1
fi
if [[ "$RESET_WINDOW" != "0" && "$RESET_WINDOW" != "1" ]]; then
  printf '%s\n' "error: CHATGPT2CODEX_RESET_UNATTENDED_WINDOW must be 0 or 1." >&2
  exit 1
fi
if [[ -z "$ALLOWLIST" ]]; then
  printf '%s\n' "error: CHATGPT2CODEX_GITHUB_PR_ALLOWLIST must contain exact repositories." >&2
  exit 1
fi
if [[ -L "$STATE_DIR" || ( -e "$STATE_DIR" && ! -d "$STATE_DIR" ) ]]; then
  printf '%s\n' "error: CHATGPT2CODEX_STATE_DIR must be a real directory, not a symlink or file." >&2
  exit 1
fi

WORKSPACE="$(cd "$WORKSPACE" && pwd)"
mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
chmod 700 "$HOME/Library/LaunchAgents" "$STATE_DIR"

export LABEL PLIST STATE_DIR WORKSPACE NODE ROOT ALLOWLIST CDP_URL INTERVAL_SECONDS DURATION_HOURS
python3 <<'PY'
import os
import plistlib
import re
import tempfile
from pathlib import Path

label = os.environ["LABEL"]
plist_path = Path(os.environ["PLIST"])
state_dir = Path(os.environ["STATE_DIR"])
workspace = Path(os.environ["WORKSPACE"])
node = os.environ["NODE"]
root = Path(os.environ["ROOT"])
allowlist = sorted({item.strip().lower() for item in os.environ["ALLOWLIST"].split(",") if item.strip()})
cdp_url = os.environ["CDP_URL"]
interval = int(os.environ["INTERVAL_SECONDS"])
duration = int(os.environ["DURATION_HOURS"])

repository_pattern = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
if not allowlist or any(
    not repository_pattern.fullmatch(repo)
    or not repo.startswith("twoimo/")
    or repo == "yeachan-heo/gajae-code"
    for repo in allowlist
):
    raise SystemExit("error: allowlist must contain only exact non-upstream twoimo repositories.")

payload = {
    "Label": label,
    "ProgramArguments": [
        node,
        str(root / "dist/cli.js"),
        "github-pr-feedback-supervisor",
        "--interval-seconds", str(interval),
        "--duration-hours", str(duration),
        "--repositories", ",".join(allowlist),
        "--workspace", str(workspace),
        "--chatgpt-cdp-url", cdp_url,
    ],
    "WorkingDirectory": str(workspace),
    "EnvironmentVariables": {
        "CHATGPT2CODEX_ACTIONS_MODE": "github-pr-monitor-write",
        "CHATGPT2CODEX_MONITOR_ROLLOUT": "enabled",
        "CHATGPT2CODEX_UNATTENDED_WRITE": "1",
        "CHATGPT2CODEX_GITHUB_PR_ALLOWLIST": ",".join(allowlist),
        "CHATGPT2CODEX_STATE_DIR": str(state_dir),
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    "RunAtLoad": True,
    "KeepAlive": {"SuccessfulExit": False},
    "ThrottleInterval": 30,
    "ProcessType": "Background",
    "LowPriorityIO": True,
    "StandardOutPath": str(state_dir / "github-pr-feedback-supervisor.log"),
    "StandardErrorPath": str(state_dir / "github-pr-feedback-supervisor.error.log"),
}

plist_path.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile("wb", dir=plist_path.parent, delete=False) as handle:
    temporary = Path(handle.name)
    plistlib.dump(payload, handle, fmt=plistlib.FMT_XML, sort_keys=False)
os.chmod(temporary, 0o600)
os.replace(temporary, plist_path)
os.chmod(plist_path, 0o600)
PY

UID_VALUE="$(id -u)"
launchctl bootout "gui/$UID_VALUE/$LABEL" || true
if [[ "$RESET_WINDOW" == "1" ]]; then
  CHATGPT2CODEX_UNATTENDED_WRITE=1 \
  CHATGPT2CODEX_MONITOR_ROLLOUT=enabled \
  CHATGPT2CODEX_STATE_DIR="$STATE_DIR" \
  "$NODE" "$ROOT/dist/cli.js" github-pr-feedback-supervisor-reset --duration-hours "$DURATION_HOURS"
fi
bootstrapped=0
sleep 2
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$UID_VALUE" "$PLIST"; then
    bootstrapped=1
    break
  fi
  sleep 2
done
if [[ "$bootstrapped" -ne 1 ]]; then
  printf '%s\n' "error: launchd could not bootstrap $LABEL after five attempts." >&2
  exit 1
fi
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
printf 'installed %s\n' "$PLIST"
