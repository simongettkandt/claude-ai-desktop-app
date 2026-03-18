#!/bin/bash
# Claude Desktop Launcher
# Findet und startet das AppImage automatisch
# Prüft Sandbox-Kompatibilität und aktiviert sie wenn möglich

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

# Sandbox-Kompatibilität prüfen
SANDBOX_SUPPORTED=true

if [ -f /proc/sys/kernel/unprivileged_userns_clone ]; then
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
    SANDBOX_SUPPORTED=false
  fi
fi

CHROME_SANDBOX="$APPIMAGE.sandbox"
if [ ! -f "$CHROME_SANDBOX" ] || [ ! -u "$CHROME_SANDBOX" ]; then
  if [ "$SANDBOX_SUPPORTED" = false ]; then
    SANDBOX_SUPPORTED=false
  fi
fi

if [ "$SANDBOX_SUPPORTED" = true ]; then
  exec "$APPIMAGE" "$@"
else
  if [ "$IS_DE" = true ]; then
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  WARNUNG: Chromium-Sandbox ist auf diesem System nicht      ║"
    echo "║  verfügbar. Die App startet im eingeschränkten Modus.       ║"
    echo "║                                                              ║"
    echo "║  Für volle Sicherheit, einmalig ausführen:                   ║"
    echo "║  sudo sysctl -w kernel.unprivileged_userns_clone=1           ║"
    echo "║                                                              ║"
    echo "║  Permanent machen:                                           ║"
    echo "║  echo 'kernel.unprivileged_userns_clone=1' |                 ║"
    echo "║    sudo tee /etc/sysctl.d/99-userns.conf                     ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
  else
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  WARNING: Chromium sandbox is not available on this system.  ║"
    echo "║  The app will start in restricted mode.                      ║"
    echo "║                                                              ║"
    echo "║  For full security, run once:                                ║"
    echo "║  sudo sysctl -w kernel.unprivileged_userns_clone=1           ║"
    echo "║                                                              ║"
    echo "║  Make permanent:                                             ║"
    echo "║  echo 'kernel.unprivileged_userns_clone=1' |                 ║"
    echo "║    sudo tee /etc/sysctl.d/99-userns.conf                     ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
  fi
  exec "$APPIMAGE" --no-sandbox "$@"
fi
