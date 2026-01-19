# DeepClause - AgentVM

AgentVM is a lightweight Node.js library that runs a WASM-based Linux virtual machine (Alpine Linux) in a worker thread. It allows you to execute shell commands and capture their output, making it an ideal sandbox for AI agents. It is developed as part of the [DeepClause project](https://github.com/deepclause/deepclause-desktop). 


The virtual machine was created using the [container2wasm (c2w)](https://github.com/container2wasm/container2wasm) project.


In order to keep dependencies minimal, this project currently uses node:wasi, which is known to have some quirks and possibly security flaws.


The entire project, including network stack and hacks for making host directory mounts possible, was coded using Opus 4.5.

> ⚠️ **DISCLAIMER**: This library is highly experimental and should be used at your own risk. It is not recommended for production use. The underlying WASI implementation may have security vulnerabilities and the API may change without notice.

## Installation

```bash
npm install agentvm
```

## Usage

```javascript
const { AgentVM } = require('agentvm');

async function main() {
    const vm = new AgentVM({
        // Path to the provided WASM file (optional if in default location)
        wasmPath: './agentvm-alpine-python.wasm' 
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
const { AgentVM } = require('agentvm');

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
const { AgentVM } = require('agentvm');

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
- `options.wasmPath`: Path to the `agentvm-alpine-python.wasm` file.
- `options.mounts`: Object mapping VM paths to host paths (e.g., `{ '/mnt/data': './data' }`). Supports reading and writing files from the VM to the host filesystem.
- `options.network`: Enable networking (default: `true`). Provides full TCP/UDP NAT for internet access.
- `options.mac`: MAC address for the VM (default: `02:00:00:00:00:01`).

### `vm.start()`
Starts the VM worker. Returns a Promise.

### `vm.exec(command)`
Executes a shell command.
- Returns: `Promise<{ stdout: string, stderr: string, exitCode: number }>`

### `vm.stop()`
Terminates the VM.

## Features

- **Full Linux VM**: Runs Alpine Linux with Python in a WASM-based emulator
- **Networking**: Built-in DHCP, DNS, and TCP/UDP NAT for internet access
- **Host Filesystem Mounts**: Mount host directories into the VM for file sharing
- **Command Execution**: Execute shell commands and capture stdout/stderr
- **Worker Thread**: Runs in a separate thread to avoid blocking the main event loop

## Vercel AI SDK Example

See `example/vercel-agent.js` for an example of how to use AgentVM as a tool for an AI agent.



## Building the WASM Image

The WASM image is built from a Docker container using container2wasm:

### 1. Install container2wasm

```bash
git clone https://github.com/nicolo-ribaudo/container2wasm.git
cd container2wasm
go build -o c2w ./cmd/c2w
```

### 2. Create the Dockerfile

```dockerfile
FROM alpine:latest
RUN apk add --no-cache python3
CMD ["/bin/sh"]
```

### 3. Build the Docker image

```bash
docker build -t agentvm-alpine-python .
```

### 4. Convert to WASM

```bash
./c2w agentvm-alpine-python agentvm-alpine-python.wasm
```

This creates the `agentvm-alpine-python.wasm` file used by AgentVM.