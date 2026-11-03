#!/usr/bin/env bash
# Installs the Cadence AppImage for the current user (no root needed):
#   ~/.local/opt/cadence/Cadence.AppImage     the app
#   ~/.local/bin/cadence                      command line launcher
#   ~/.local/share/applications/cadence.desktop + icon
# Launchers that read the XDG application folders (Noctalia, GNOME, KDE, rofi/wofi/fuzzel …) list it right away.
#
#   ./install.sh                      install the newest build/desktop/Cadence-*.AppImage
#   ./install.sh path/to/Cadence.AppImage
#   ./install.sh --build              build it first (npm run desktop:dist), then install
#   ./install.sh --uninstall          remove it again (your data in ~/.config/Cadence stays)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
OPT_DIR="$HOME/.local/opt/cadence"
BIN_DIR="$HOME/.local/bin"
APP="$OPT_DIR/Cadence.AppImage"
DESKTOP="$DATA_HOME/applications/cadence.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ICON="$ICON_DIR/cadence.png"

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

refresh_caches() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA_HOME/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing Cadence"
  rm -f "$APP" "$BIN_DIR/cadence" "$DESKTOP" "$ICON"
  rmdir "$OPT_DIR" 2>/dev/null || true
  refresh_caches
  say "Done. Your data is still in ~/.config/Cadence (delete it yourself if you want)."
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux (Windows: use the Cadence-Setup .exe, macOS: npm run mac)."

SRC="${1:-}"
if [ "$SRC" = "--build" ]; then
  command -v npm >/dev/null || die "npm is needed to build (Node.js 24+)."
  say "Building the desktop app (npm run desktop:dist)"
  (cd "$ROOT" && npm install --no-audit --no-fund && npm run desktop:dist)
  SRC=""
fi
if [ -z "$SRC" ]; then
  SRC="$(ls -t "$ROOT"/build/desktop/Cadence-*-linux-*.AppImage 2>/dev/null | head -1 || true)"
  [ -n "$SRC" ] || die "No AppImage found in build/desktop. Run ./install.sh --build, or pass the path of a downloaded AppImage."
fi
[ -f "$SRC" ] || die "Not found: $SRC"

say "Installing $(basename "$SRC")"
mkdir -p "$OPT_DIR" "$BIN_DIR" "$DATA_HOME/applications" "$ICON_DIR"
# copy to a temporary name first: replacing a running AppImage in place would break it
install -m 755 "$SRC" "$APP.new"
mv -f "$APP.new" "$APP"

# AppImages mount themselves with FUSE 2; without libfuse2 they can still unpack and run
EXEC="$APP"
has_fuse2() {
  # no `grep -q` on the pipe: it exits early and pipefail would count ldconfig's SIGPIPE as failure
  ldconfig -p 2>/dev/null | grep 'libfuse.so.2' >/dev/null && return 0
  for f in /usr/lib/libfuse.so.2 /usr/lib64/libfuse.so.2 /usr/lib/x86_64-linux-gnu/libfuse.so.2 /lib/x86_64-linux-gnu/libfuse.so.2; do
    [ -e "$f" ] && return 0
  done
  return 1
}
if ! has_fuse2; then
  say "libfuse2 not found: Cadence will unpack itself on each start (install fuse2 / libfuse2 for a faster start)"
  EXEC="env APPIMAGE_EXTRACT_AND_RUN=1 $APP"
fi

cat >"$BIN_DIR/cadence" <<EOF
#!/usr/bin/env sh
exec $EXEC "\$@"
EOF
chmod 755 "$BIN_DIR/cadence"

# icon: from the repo, or pulled out of the AppImage when installing a downloaded one
if [ -f "$ROOT/apps/desktop/resources/icon.png" ]; then
  install -m 644 "$ROOT/apps/desktop/resources/icon.png" "$ICON"
else
  tmp="$(mktemp -d)"
  (cd "$tmp" && "$APP" --appimage-extract '*.png' >/dev/null 2>&1 || true)
  found="$(find "$tmp" -name '*.png' -size +10k | head -1)"
  [ -n "$found" ] && install -m 644 "$found" "$ICON"
  rm -rf "$tmp"
fi

cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Cadence
GenericName=Training log
Comment=Training log for Apple Health, COROS and FIT files
Exec=$EXEC %U
TryExec=$APP
Icon=$ICON
Terminal=false
Categories=Education;Sports;
Keywords=training;running;cycling;fitness;health;coros;strava;
StartupWMClass=cadence
StartupNotify=true
EOF
chmod 644 "$DESKTOP"
refresh_caches

say "Installed. Start Cadence from your launcher (Noctalia lists it right away) or run: cadence"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Note: $BIN_DIR is not on your PATH (fish: fish_add_path ~/.local/bin)" ;;
esac
