#!/usr/bin/env bash
# Produce image/preinstalled/usrlocal by running the real npm install inside
# the current optimized AgentVM image and exporting /usr/local via a mounted
# host directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
IMAGE="${AGENTVM_WASM:-$HERE/agentvm-alpine-python-node-optimized.wasm}"
STAGING="$HERE/preinstalled"
PACKAGE="${1:-@earendil-works/pi-coding-agent}"

rm -rf "$STAGING"
mkdir -p "$STAGING"

node - "$REPO" "$IMAGE" "$STAGING" "$PACKAGE" <<'NODE'
const [repo, image, staging, pkg] = process.argv.slice(2);
const { AgentVM } = require(`${repo}/src`);

(async () => {
  const vm = new AgentVM({
    wasmPath: image,
    network: true,
    mounts: { '/mnt': staging },
  });
  try {
    await vm.start();
    const result = await vm.exec(
      `npm install -g --ignore-scripts --min-release-age 0 --no-fund --no-audit --loglevel warn --progress=false ${pkg} && ` +
      `tar -cf /mnt/usrlocal.tar -C /usr/local . && echo PREINSTALL_DONE`
    );
    if (result.exitCode !== 0) {
      console.error(result.stdout.slice(-4000));
      console.error(result.stderr.slice(-4000));
      process.exit(result.exitCode || 1);
    }
    console.log(result.stdout.slice(-2000));
  } finally {
    await vm.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

mkdir -p "$STAGING/usrlocal"
tar -xf "$STAGING/usrlocal.tar" -C "$STAGING/usrlocal"
rm -f "$STAGING/usrlocal.tar"
echo "preinstalled: $STAGING/usrlocal"
du -sh "$STAGING/usrlocal"
