#!/usr/bin/env bash
# TD-023 codification: install the dev-launch taskbar icons and .desktop
# entries for local (non-packaged) Tide development on a fresh machine.
#
# Why: under Wayland, a dev-launched Tauri binary gets the app_id of the
# BINARY STEM ("app" from src-tauri/target/debug/app), not the bundle
# identifier (com.tide.app). The desktop therefore needs icon/desktop entries
# under BOTH names for the taskbar to show the Tide icon in dev sessions.
# Release builds (RPM/DEB) are correctly keyed to com.tide.app and make this
# moot — this script is dev-environment-only.
#
# Idempotent: safe to re-run; overwrites with current repo icons.
set -euo pipefail
cd "$(dirname "$0")/.."

ICON_SRC="src-tauri/icons"
DEST_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
BIN_STEM="app"          # Wayland app_id of the dev binary (cargo target stem)
BUNDLE_ID="com.tide.app"

SIZES=("32x32:32x32.png" "64x64:64x64.png" "128x128:128x128.png" "256x256:icon.png")

for entry in "${SIZES[@]}"; do
  size="${entry%%:*}"
  file="${entry##*:}"
  for name in "$BUNDLE_ID" "$BIN_STEM"; do
    dir="$DEST_BASE/$size/apps"
    mkdir -p "$dir"
    cp "$ICON_SRC/$file" "$dir/$name.png"
    echo "installed $dir/$name.png"
  done
done

# .desktop for dev sessions (StartupWMClass matches the binary stem so the
# running dev window associates with the entry).
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/$BUNDLE_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tide (dev)
Exec=$PWD/src-tauri/target/debug/app
Icon=$BUNDLE_ID
StartupWMClass=$BIN_STEM
Categories=Office;Calendar;
EOF
echo "installed $DESKTOP_DIR/$BUNDLE_ID.desktop"

# Refresh caches so KDE/GTK pick the icons up immediately.
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$DEST_BASE" >/dev/null 2>&1 || true
echo "done."
