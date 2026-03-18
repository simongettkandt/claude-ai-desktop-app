#!/bin/bash
# Claude Desktop Launcher
# Findet und startet das AppImage automatisch

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE="$SCRIPT_DIR/Claude-Desktop-1.1.1.AppImage"

# Sprache erkennen (de = Deutsch, sonst Englisch)
LANG_PREFIX="${LANG%%_*}"
if [ "$LANG_PREFIX" = "de" ] || [ "${LANGUAGE%%:*}" = "de" ]; then
  IS_DE=true
else
  IS_DE=false
fi

if [ ! -f "$APPIMAGE" ]; then
  APPIMAGE=$(find "$SCRIPT_DIR" -name "Claude-Desktop-*.AppImage" -type f | head -1)
fi

if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
  if [ "$IS_DE" = true ]; then
    echo "Fehler: Claude-Desktop AppImage nicht gefunden."
  else
    echo "Error: Claude Desktop AppImage not found."
  fi
  exit 1
fi

chmod +x "$APPIMAGE"

# AppImages können die Chromium SUID-Sandbox nicht nutzen (chrome-sandbox
# braucht root:4755, was im gemounteten AppImage nicht möglich ist).
# --no-sandbox deaktiviert nur die OS-Level Prozess-Sandbox.
# Die Web-Content-Sandbox (sandbox: true in webPreferences) bleibt aktiv.
exec "$APPIMAGE" --no-sandbox "$@"
