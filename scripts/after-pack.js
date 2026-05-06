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
case " $* " in
  *" --no-sandbox "*) exec "$DIR/${exeName}.bin" "$@" ;;
  *) exec "$DIR/${exeName}.bin" --no-sandbox "$@" ;;
esac
`;

  fs.writeFileSync(realPath, wrapper, { mode: 0o755 });
};
