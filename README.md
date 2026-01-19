# AgentVM

AgentVM is a lightweight Node.js library that runs a WASM-based Linux virtual machine (Alpine Linux) in a worker thread. It allows you to execute shell commands and capture their output, making it an ideal sandbox for AI agents.

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

## API

### `new AgentVM(options)`
- `options.wasmPath`: Path to the `agentvm-alpine-python.wasm` file.
- `options.mounts`: Object mapping VM paths to host paths (e.g., `{ '/mnt/data': './data' }`). **Note:** Directory mounts are currently not working due to a compatibility issue between Node.js WASI and the c2w virtio-9p driver.
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
- **Command Execution**: Execute shell commands and capture stdout/stderr
- **Worker Thread**: Runs in a separate thread to avoid blocking the main event loop

## Vercel AI SDK Example

See `example/vercel-agent.js` for an example of how to use AgentVM as a tool for an AI agent.
