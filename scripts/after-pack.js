const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const dir = context.appOutDir;
  const exeName = context.packager.executableName;
  const realPath = path.join(dir, exeName);
  const binPath = path.join(dir, exeName + '.bin');

  if (fs.existsSync(binPath)) return;
  if (!fs.existsSync(realPath)) return;

  fs.renameSync(realPath, binPath);

  const wrapper = `#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"

# Wayland-Bypass: BrowserWindow x/y ist unter nativem Wayland no-op,
# Pop-ups landen zufaellig. Loesung: ueber XWayland rendern. Switch
# muss VOR Electron-Init am argv stehen, deshalb hier im Wrapper.
# VS Code, Discord, Signal, Obsidian machen es genauso.
WL_ARGS=()
if [ -n "$WAYLAND_DISPLAY" ] && [ "$XDG_SESSION_TYPE" = "wayland" ]; then
  WL_ARGS=(--ozone-platform=x11)
fi

case " $* " in
  *" --no-sandbox "*) exec "$DIR/${exeName}.bin" "\${WL_ARGS[@]}" "$@" ;;
  *) exec "$DIR/${exeName}.bin" --no-sandbox "\${WL_ARGS[@]}" "$@" ;;
esac
`;

  fs.writeFileSync(realPath, wrapper, { mode: 0o755 });
};
