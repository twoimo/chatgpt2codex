#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-ChatGPT To Codex}"
BUNDLE_ID="${BUNDLE_ID:-app.ezbuilder.chatgpt2codex}"
VERSION="$(node -p 'require("./package.json").version')"
BUILD_DIR="$ROOT/build/macos"
APP_DIR="$BUILD_DIR/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/chatgpt2codex"
DEPS_DIR="$BUILD_DIR/deps"
PKG_SCRIPTS_DIR="$BUILD_DIR/pkg-scripts"
UNSIGNED_PKG="$BUILD_DIR/chatgpt2codex-${VERSION}.pkg"
SIGNED_PKG="$BUILD_DIR/chatgpt2codex-${VERSION}-signed.pkg"
OPERATOR_ENTITLEMENTS="$BUILD_DIR/operator-helper.entitlements.plist"

find_codesign_identity() {
  local needle="$1"
  security find-identity -v -p codesigning | awk -F '"' -v needle="$needle" '$0 ~ needle { print $2; exit }'
}

find_basic_identity() {
  local needle="$1"
  security find-identity -v | awk -F '"' -v needle="$needle" '$0 ~ needle { print $2; exit }'
}

download_with_cache() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" ]]; then
    return 0
  fi
  curl -fsSL "$url" -o "$out"
}

bundle_node_runtime() {
  if [[ "${CHATGPT2CODEX_BUNDLE_NODE:-1}" == "0" ]]; then
    return 0
  fi
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
    echo "error: packaging requires Node.js 22.16.0 or newer; found $(node -v 2>/dev/null || echo unknown)." >&2
    return 1
  fi
  local node_version node_arch node_dist node_url node_tgz
  node_version="$(node -p 'process.versions.node')"
  case "$(uname -m)" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) echo "warning: unsupported macOS arch for bundled Node: $(uname -m)" >&2; return 0 ;;
  esac
  node_dist="node-v${node_version}-darwin-${node_arch}"
  node_tgz="$DEPS_DIR/${node_dist}.tar.gz"
  node_url="https://nodejs.org/dist/v${node_version}/${node_dist}.tar.gz"
  mkdir -p "$DEPS_DIR" "$RUNTIME_DIR/bin"
  if [[ ! -d "$DEPS_DIR/$node_dist" ]]; then
    echo "fetching bundled Node.js runtime: $node_url"
    if download_with_cache "$node_url" "$node_tgz"; then
      tar -xzf "$node_tgz" -C "$DEPS_DIR"
    else
      echo "warning: could not fetch Node.js runtime; installed app needs system Node.js 22.16.0 or newer." >&2
      return 0
    fi
  fi
  rm -rf "$RUNTIME_DIR/node"
  cp -R "$DEPS_DIR/$node_dist" "$RUNTIME_DIR/node"
  ln -sf "../node/bin/node" "$RUNTIME_DIR/bin/node"
  ln -sf "../node/bin/npm" "$RUNTIME_DIR/bin/npm"
  ln -sf "../node/bin/npx" "$RUNTIME_DIR/bin/npx"
}

bundle_cloudflared() {
  mkdir -p "$RUNTIME_DIR/bin"
  if command -v cloudflared >/dev/null 2>&1; then
    cp "$(command -v cloudflared)" "$RUNTIME_DIR/bin/cloudflared"
    chmod +x "$RUNTIME_DIR/bin/cloudflared"
    return 0
  fi
  if [[ "${CHATGPT2CODEX_BUNDLE_CLOUDFLARED:-1}" == "0" ]]; then
    return 0
  fi
  local cf_arch cf_tgz cf_url cf_dir
  case "$(uname -m)" in
    arm64) cf_arch="arm64" ;;
    x86_64) cf_arch="amd64" ;;
    *) echo "warning: unsupported macOS arch for bundled cloudflared: $(uname -m)" >&2; return 0 ;;
  esac
  cf_dir="$DEPS_DIR/cloudflared-darwin-${cf_arch}"
  cf_tgz="$DEPS_DIR/cloudflared-darwin-${cf_arch}.tgz"
  cf_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${cf_arch}.tgz"
  mkdir -p "$cf_dir"
  echo "fetching bundled cloudflared: $cf_url"
  if download_with_cache "$cf_url" "$cf_tgz"; then
    tar -xzf "$cf_tgz" -C "$cf_dir"
    if [[ -f "$cf_dir/cloudflared" ]]; then
      cp "$cf_dir/cloudflared" "$RUNTIME_DIR/bin/cloudflared"
      chmod +x "$RUNTIME_DIR/bin/cloudflared"
    fi
  else
    echo "warning: could not fetch cloudflared; ChatGPT web connector can install it with Homebrew later." >&2
  fi
}

write_pkg_scripts() {
  rm -rf "$PKG_SCRIPTS_DIR"
  mkdir -p "$PKG_SCRIPTS_DIR"
  cat >"$PKG_SCRIPTS_DIR/postinstall" <<EOF
#!/bin/sh
set -u
APP_RUNTIME="/Applications/${APP_NAME}.app/Contents/Resources/chatgpt2codex"
LOG_DIR="/Users/Shared/ChatGPT To Codex"
LOG_FILE="\$LOG_DIR/install-doctor.log"
mkdir -p "\$LOG_DIR"
if [ -x "\$APP_RUNTIME/macos-dependency-doctor.sh" ]; then
  "\$APP_RUNTIME/macos-dependency-doctor.sh" >"\$LOG_FILE" 2>&1 || true
else
  printf '%s\n' "Doctor script not found at \$APP_RUNTIME/macos-dependency-doctor.sh" >"\$LOG_FILE"
fi
exit 0
EOF
  chmod +x "$PKG_SCRIPTS_DIR/postinstall"
}

APP_SIGN_IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -z "$APP_SIGN_IDENTITY" ]]; then
  APP_SIGN_IDENTITY="$(find_codesign_identity "Developer ID Application")"
fi
if [[ -z "$APP_SIGN_IDENTITY" ]]; then
  APP_SIGN_IDENTITY="$(find_codesign_identity "Apple Development")"
fi
PKG_SIGN_IDENTITY="${PKG_SIGN_IDENTITY:-$(find_basic_identity "Developer ID Installer")}"
HELPER_BUNDLE_ID="${OPERATOR_HELPER_BUNDLE_ID:-${BUNDLE_ID}.operator-helper}"
PROVISIONING_PROFILE_PATH="${PROVISIONING_PROFILE_PATH:-}"
TEAM_ID="${CODESIGN_TEAM_ID:-}"
if [[ -z "$TEAM_ID" && "$APP_SIGN_IDENTITY" =~ \(([A-Z0-9]{10})\)$ ]]; then
  TEAM_ID="${BASH_REMATCH[1]}"
fi
if [[ -z "$APP_SIGN_IDENTITY" || "$APP_SIGN_IDENTITY" == "-" ]]; then
  echo "error: a real Apple code-signing identity is required for the Secure Enclave operator helper." >&2
  exit 1
fi
if [[ ! "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "error: CODESIGN_TEAM_ID or a ten-character team ID in CODESIGN_IDENTITY is required." >&2
  exit 1
fi
if [[ ! "$BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ || ! "$HELPER_BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "error: bundle identifiers contain unsupported characters." >&2
  exit 1
fi

write_operator_helper_entitlements() {
  python3 - "$ROOT/macos/ChatGPTToCodexStatusBar/operator-helper.entitlements.plist" "$OPERATOR_ENTITLEMENTS" "$TEAM_ID" "$BUNDLE_ID" "$HELPER_BUNDLE_ID" <<'PY'
import sys
from pathlib import Path

template_path, output_path, team_id, bundle_id, helper_bundle_id = sys.argv[1:]
rendered = Path(template_path).read_text(encoding="utf-8")
for marker, value in {
    "__TEAM_ID__": team_id,
    "__BUNDLE_ID__": bundle_id,
    "__HELPER_BUNDLE_ID__": helper_bundle_id,
}.items():
    rendered = rendered.replace(marker, value)
if "__" in rendered:
    raise SystemExit("unresolved operator-helper entitlement placeholder")
Path(output_path).write_text(rendered, encoding="utf-8")
PY
}

cd "$ROOT"
npm run build
python3 "$ROOT/scripts/generate-macos-icon.py" --out "build/macos/generated-icons"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$RUNTIME_DIR"
write_operator_helper_entitlements

cp "$ROOT/macos/ChatGPTToCodexStatusBar/Info.plist" "$CONTENTS_DIR/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$CONTENTS_DIR/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS_DIR/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$CONTENTS_DIR/Info.plist" >/dev/null
if [[ -n "$PROVISIONING_PROFILE_PATH" ]]; then
  if [[ ! -f "$PROVISIONING_PROFILE_PATH" || -L "$PROVISIONING_PROFILE_PATH" ]]; then
    echo "error: PROVISIONING_PROFILE_PATH must name a regular provisioning profile file." >&2
    exit 1
  fi
  cp "$PROVISIONING_PROFILE_PATH" "$CONTENTS_DIR/embedded.provisionprofile"
fi

swiftc -O \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  "$ROOT/macos/ChatGPTToCodexStatusBar/main.swift" \
  -o "$MACOS_DIR/ChatGPTToCodexStatusBar"
swiftc -O \
  -framework Foundation \
  -framework Security \
  "$ROOT/macos/ChatGPTToCodexStatusBar/operator-helper.swift" \
  -o "$MACOS_DIR/chatgpt2codex-operator-helper"

# Native AX semantic-targeting helper for Option B desktop control (see
# src/control/mac-input.ts resolveHelperPath). Lives next to the status-bar
# binary so it inherits the same code signature and Accessibility TCC grant
# (both are covered by the single `codesign --deep` below).
swiftc -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation \
  "$ROOT/macos/ChatGPTToCodexStatusBar/ax-helper.swift" \
  -o "$MACOS_DIR/chatgpt2codex-ax"

if [[ -f "$ROOT/deployment/github-pr-write-manifest.v1.json" && -f "$ROOT/deployment/github-pr-write-manifest.v1.sig" ]]; then
  mkdir -p "$RESOURCES_DIR/deployment"
  cp "$ROOT/deployment/github-pr-write-manifest.v1.json" "$ROOT/deployment/github-pr-write-manifest.v1.sig" "$RESOURCES_DIR/deployment/"
fi
cp "$BUILD_DIR/generated-icons/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
cp "$BUILD_DIR/generated-icons/StatusIconTemplate.png" "$RESOURCES_DIR/StatusIconTemplate.png"
cp "$ROOT/assets/chatgpt2codex-icon.png" "$RESOURCES_DIR/chatgpt2codex-icon.png"

cp -R "$ROOT/dist" "$RUNTIME_DIR/dist"
find "$RUNTIME_DIR/dist" -name '*.map' -type f -delete
verify_runtime_dist_parity() {
  local source_file relative_path bundled_file
  while IFS= read -r -d '' source_file; do
    case "$source_file" in
      *.map) continue ;;
    esac
    relative_path="${source_file#"$ROOT/dist/"}"
    bundled_file="$RUNTIME_DIR/dist/$relative_path"
    [[ -f "$bundled_file" ]] || { echo "error: packaged dist is missing $relative_path" >&2; return 1; }
    cmp -s "$source_file" "$bundled_file" || { echo "error: packaged dist differs at $relative_path" >&2; return 1; }
  done < <(find "$ROOT/dist" -type f -print0)
  while IFS= read -r -d '' bundled_file; do
    relative_path="${bundled_file#"$RUNTIME_DIR/dist/"}"
    [[ "$relative_path" == *.map ]] && continue
    [[ -f "$ROOT/dist/$relative_path" ]] || { echo "error: packaged dist contains unexpected $relative_path" >&2; return 1; }
  done < <(find "$RUNTIME_DIR/dist" -type f -print0)
}
verify_runtime_dist_parity
cp "$ROOT/package.json" "$RUNTIME_DIR/package.json"
cp "$ROOT/package-lock.json" "$RUNTIME_DIR/package-lock.json"
cp "$ROOT/start-chatgpt.sh" "$RUNTIME_DIR/start-chatgpt.sh"
cp "$ROOT/scripts/macos-dependency-doctor.sh" "$RUNTIME_DIR/macos-dependency-doctor.sh"
cp -R "$ROOT/assets" "$RUNTIME_DIR/assets"
mkdir -p "$RUNTIME_DIR/docs"
cp "$ROOT/docs/INSTALL.md" "$RUNTIME_DIR/docs/INSTALL.md"

bundle_node_runtime
bundle_cloudflared

(
  cd "$RUNTIME_DIR"
  npm ci --omit=dev --ignore-scripts --prefer-offline
)
find "$RUNTIME_DIR/node_modules" -name '*.map' -type f -delete
find "$RUNTIME_DIR/node_modules" -name '*.ts' ! -name '*.d.ts' -type f -delete
find "$APP_DIR" -name '._*' -type f -delete

chmod +x "$MACOS_DIR/ChatGPTToCodexStatusBar" "$MACOS_DIR/chatgpt2codex-ax" "$MACOS_DIR/chatgpt2codex-operator-helper" "$RUNTIME_DIR/start-chatgpt.sh" "$RUNTIME_DIR/macos-dependency-doctor.sh"
write_pkg_scripts
xattr -cr "$APP_DIR" || true

codesign --force --deep --options runtime --timestamp --sign "$APP_SIGN_IDENTITY" "$APP_DIR"
codesign --force --options runtime --timestamp \
  --entitlements "$OPERATOR_ENTITLEMENTS" \
  --identifier "$HELPER_BUNDLE_ID" \
  --sign "$APP_SIGN_IDENTITY" \
  "$MACOS_DIR/chatgpt2codex-operator-helper"
codesign --force --options runtime --timestamp --sign "$APP_SIGN_IDENTITY" "$APP_DIR"
codesign --verify --strict --verbose=2 "$MACOS_DIR/chatgpt2codex-operator-helper"
codesign --display --entitlements :- "$MACOS_DIR/chatgpt2codex-operator-helper" | grep -Fq "${TEAM_ID}.${BUNDLE_ID}.operator" || {
  echo "error: signed operator helper is missing its team-scoped keychain entitlement." >&2
  exit 1
}

codesign --verify --deep --strict --verbose=2 "$APP_DIR"

rm -f "$UNSIGNED_PKG" "$SIGNED_PKG"
pkgbuild --component "$APP_DIR" --install-location /Applications --scripts "$PKG_SCRIPTS_DIR" "$UNSIGNED_PKG"

if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
  productsign --sign "$PKG_SIGN_IDENTITY" "$UNSIGNED_PKG" "$SIGNED_PKG"
  pkgutil --check-signature "$SIGNED_PKG"
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    xcrun notarytool submit "$SIGNED_PKG" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
    xcrun stapler staple "$SIGNED_PKG"
    spctl -a -vv --type install "$SIGNED_PKG"
  fi
  echo "$SIGNED_PKG"
else
  echo "warning: Developer ID Installer identity not found; pkg is unsigned but contains a signed app." >&2
  pkgutil --check-signature "$UNSIGNED_PKG" || true
  echo "$UNSIGNED_PKG"
fi
