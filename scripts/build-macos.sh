#!/usr/bin/env bash
# Builds build/Cadence.app: web UI + server bundle + official Node.js runtime + native Swift shell.
#   npm run mac            → build/Cadence.app
#   npm run mac -- --dmg   → also build/Cadence-<version>.dmg
#   npm run mac -- --install → also copy the app to /Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
APP="$OUT/Cadence.app"
MAKE_DMG=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dmg) MAKE_DMG=1 ;;
    --install) INSTALL=1 ;;
  esac
done

ARCH="$(uname -m)"
NODE_ARCH=$([ "$ARCH" = "arm64" ] && echo arm64 || echo x64)
NODE_VERSION="${CADENCE_NODE_VERSION:-$(node -p 'process.versions.node')}"
CACHE="${CADENCE_CACHE_DIR:-$HOME/Library/Caches/cadence}"
VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "▸ Building web UI and server bundle"
(cd "$ROOT" && npm run build >/dev/null)

# The app ships the official, self-contained Node.js binary (Homebrew's node links against
# Homebrew libraries and would break on other Macs or after `brew upgrade`).
NODE_DIR="$CACHE/node-v$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "▸ Downloading Node.js $NODE_VERSION ($NODE_ARCH) from nodejs.org"
  mkdir -p "$CACHE"
  TARBALL="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" >"$CACHE/$TARBALL.sha256"
  (cd "$CACHE" && shasum -a 256 -c "$TARBALL.sha256" >/dev/null)
  tar -xzf "$CACHE/$TARBALL" -C "$CACHE"
  rm -f "$CACHE/$TARBALL" "$CACHE/$TARBALL.sha256"
fi

echo "▸ Compiling the macOS shell"
swift build -c release --package-path "$ROOT/apps/macos" >/dev/null
BIN_DIR="$(swift build -c release --package-path "$ROOT/apps/macos" --show-bin-path)"

echo "▸ Assembling $APP"
rm -rf "$APP"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES/node/bin" "$RES/server" "$RES/web"
cp "$BIN_DIR/Cadence" "$APP/Contents/MacOS/Cadence"
cp "$NODE_DIR/bin/node" "$RES/node/bin/node"
cp "$NODE_DIR/LICENSE" "$RES/node/LICENSE"
cp "$ROOT/apps/server/dist/index.js" "$RES/server/index.js"
cp -R "$ROOT/apps/web/dist/." "$RES/web/"

ICONSET="$OUT/AppIcon.iconset"
rm -rf "$ICONSET"
swift "$ROOT/apps/macos/scripts/make-icon.swift" "$ICONSET" >/dev/null
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"
rm -rf "$ICONSET"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Cadence</string>
  <key>CFBundleDisplayName</key><string>Cadence</string>
  <key>CFBundleIdentifier</key><string>io.github.devine-coder.cadence</string>
  <key>CFBundleExecutable</key><string>Cadence</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.healthcare-fitness</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>Cadence — your training, from Apple Health</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Apple Health Export</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array><string>public.zip-archive</string><string>public.xml</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>FIT Activity</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array><string>com.garmin.fit</string></array>
    </dict>
  </array>
  <!-- macOS has no type for FIT files (Garmin, COROS, Wahoo …): without it they could not be dropped on the Dock icon -->
  <key>UTImportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>com.garmin.fit</string>
      <key>UTTypeDescription</key><string>FIT Activity</string>
      <key>UTTypeConformsTo</key><array><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>fit</string></array>
      </dict>
    </dict>
  </array>
</dict>
</plist>
PLIST

# Ad-hoc signature so Gatekeeper on Apple Silicon accepts the locally built bundle.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"
echo "✓ Built $APP ($(du -sh "$APP" | cut -f1))"

if [ "$MAKE_DMG" = 1 ]; then
  DMG="$OUT/Cadence-$VERSION.dmg"
  STAGE="$OUT/dmg"
  rm -rf "$STAGE" "$DMG"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Cadence" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$STAGE"
  echo "✓ Built $DMG"
fi

if [ "$INSTALL" = 1 ]; then
  rm -rf "/Applications/Cadence.app"
  cp -R "$APP" /Applications/
  echo "✓ Installed to /Applications/Cadence.app"
fi
