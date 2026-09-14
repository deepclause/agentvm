# DeepClause - AgentVM

AgentVM is a lightweight Node.js library that runs a WASM-based Linux virtual machine (Alpine Linux) in a worker thread. It allows you to execute shell commands and capture their output, making it an ideal sandbox for AI agents. It is developed as part of the [DeepClause project](https://github.com/deepclause/deepclause-desktop). 


The virtual machine was created using the [container2wasm (c2w)](https://github.com/container2wasm/container2wasm) project.


In order to keep dependencies minimal, this project currently uses node:wasi, which is known to have some quirks and possibly security flaws.


The entire project, including network stack and hacks for making host directory mounts possible, was coded using various coding agents and models.

> ⚠️ **DISCLAIMER**: This library is highly experimental and should be used at your own risk. It is not recommended for production use. The underlying WASI implementation may have security vulnerabilities and the API may change without notice.

Latest version on npm: 0.3.0

## Installation

```bash
npm install deepclause-agentvm
```

## Usage

```javascript
const { AgentVM } = require('deepclause-agentvm');

async function main() {
    const vm = new AgentVM({
        // Path to the VM WASM file (optional, will be installed automatically with npm)
        // wasmPath: './agentvm-alpine-python.wasm' 
    });

    await vm.start();

    const result = await vm.exec('echo "Hello World"');
    console.log(result.stdout); // "Hello World"

    await vm.stop();
}

main();
```

### With Host Filesystem Mount

```javascript
const { AgentVM } = require('deepclause-agentvm');

async function main() {
    const vm = new AgentVM({
        mounts: { '/mnt/data': './my-data-folder' }
    });

    await vm.start();

    // Write a file from the VM to the host
    await vm.exec('echo "Hello from VM" > /mnt/data/greeting.txt');

    // Read a file from the host in the VM
    const result = await vm.exec('cat /mnt/data/greeting.txt');
    console.log(result.stdout); // "Hello from VM"

    await vm.stop();
}

main();
```

### With Networking

```javascript
const { AgentVM } = require('deepclause-agentvm');

async function main() {
    const vm = new AgentVM({ network: true }); // network is enabled by default

    await vm.start(); // Network is auto-configured via DHCP

    // Download from the internet
    const result = await vm.exec('wget -q -O- http://example.com | head -5');
    console.log(result.stdout);

    await vm.stop();
}

main();
```

## API

### `new AgentVM(options)`
- `options.wasmPath`: Path to the `agentvm-alpine-python.wasm` file. Part of the npm package by default.
- `options.mounts`: Object mapping VM paths to host paths (e.g., `{ '/mnt/data': './data' }`). Supports reading and writing files from the VM to the host filesystem.
- `options.network`: Enable networking (default: `true`). Provides full TCP/UDP NAT for internet access.
- `options.mac`: MAC address for the VM (default: `02:00:00:00:00:01`).
- `options.networkRateLimit`: VM-wide network rate limit in bytes/sec (default: 2 MiB/s). Set to `0` for unlimited.
- `options.debug`: Enable debug logging.
- `options.interactive`: Interactive/raw mode — skip shell setup for direct terminal access.
- `options.persistentRoot`: Persist the guest root filesystem per workspace via an ext4 overlay upperdir on a second virtio block device (default: `false`). Requires a `/workspace` mount.
- `options.persistentRootDir`: HOST directory where the overlay image (`upper.img`) lives. Defaults to `<workspaceHost>/.agentvm` when a `/workspace` mount is present; otherwise this option is required.

### `vm.start()`
Starts the VM worker. Returns a Promise.

### `vm.exec(command)`
Executes a shell command.
- Returns: `Promise<{ stdout: string, stderr: string, exitCode: number }>`

### `vm.writeToStdin(data)`
Write raw bytes/strings to the VM console (interactive mode).

### `vm.setupNetwork()`
Manually bring up `eth0` and run DHCP. Called automatically by `start()` in exec mode. Returns `Promise<{ ip, gateway }>`.

### Interactive-mode callbacks
Set `vm.onStdout`, `vm.onStderr`, and `vm.onExit` to receive raw console output and exit events when `interactive: true`.

### `vm.stop(options?)`
Terminates the VM. When `persistentRoot` is enabled, runs `sync` first so ext4/overlay writes are flushed to the backing image.

### `vm.setNetworkEnabled(boolean)`
Enable or disable guest networking at runtime without a VM restart. Disabling drops all live TCP/UDP host sockets immediately.

### `vm.setFirewall({ default, rules })` / `vm.clearFirewall()`
Install or clear ordered firewall rules. Rules are `{ id, direction: 'in'|'out', protocol: 'tcp'|'udp', remote: hostname|IP|CIDR|'*', port: number|range|'*', action: 'allow'|'deny' }`. First match wins.

### `vm.addPortForward({ hostPort, guestPort, guestHost?, bind? })`
Expose a guest TCP server on a host port at runtime. `guestHost` defaults to `192.168.127.3`; `bind` defaults to `127.0.0.1` (use `0.0.0.0` for LAN exposure). Returns a Promise.

### `vm.removePortForward(hostPort)` / `vm.listPortForwards()`
Remove or list live port forwards.

### `vm.snapshotRoot()`
Optional tar backup of the guest root (minus `/workspace`, `/proc`, `/sys`, `/dev`, `/run`) to `<persistentRootDir>/root.tar`. Not used by the default ext4-overlay persistence path.

## Features

- **Full Linux VM**: Runs Alpine Linux with Python in a WASM-based emulator
- **Networking**: Built-in DHCP, DNS, and TCP/UDP NAT for internet access
- **Network control**: runtime network on/off, ordered firewall rules, and TCP port forwarding
- **Persistent root**: optional per-workspace ext4 overlay so guest-root changes survive restarts
- **Host Filesystem Mounts**: Mount host directories into the VM for file sharing
- **Command Execution**: Execute shell commands and capture stdout/stderr
- **Worker Thread**: Runs in a separate thread to avoid blocking the main event loop

## Vercel AI SDK Example

See `example/vercel-agent.js` for an example of how to use AgentVM as a tool for an AI agent.



## Building the WASM Image

The image is built from Docker + [container2wasm (c2w)](https://github.com/container2wasm/container2wasm), but it is **not** a plain `c2w` invocation — `image/build.sh` applies several required patches to the TinyEMU/c2w source before building.

### Prerequisites (build machine only)

- Docker with buildx
- riscv64 binfmt: `docker run --privileged --rm tonistiigi/binfmt --install riscv64`
- `c2w` on `PATH` (or set `C2W=/path/to/c2w`)

### Build

```bash
cd image
C2W=/path/to/c2w ./build.sh [out.wasm]
```

`build.sh` performs the patching the image depends on:

- applies `patches/tinyemu-*.patch` — `fence.tso` support (required for Node),
  JIT hooks/exports, a same-page branch fast path, and the writable second
  drive (`drive1` opened read-write via `pread`/`pwrite`)
- patches the embedded c2w spec to allow block devices and add `CAP_SYS_ADMIN`
- adds `drive1: { file: "/agentvm-persist/upper.img" }` to the TinyEMU config
  (the non-9p ext4 overlay upperdir used by `persistentRoot`)
- runs Binaryen `wasm-opt` and snapshots the result with Wizer

### Preinstalled pi variant

```bash
cd image
./preinstall-pi.sh            # generates preinstalled/usrlocal (runs npm install in a VM)
./build-pi.sh agentvm-alpine-python.wasm
```

This produces the `pi`-preinstalled image that `AgentVM` ships by default.

See `image/README.md` for details on the patches and optimizations.