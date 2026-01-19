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
- `options.mounts`: Object mapping VM paths to host paths (e.g., `{ '/mnt/data': './data' }`).

### `vm.start()`
Starts the VM worker. Returns a Promise.

### `vm.exec(command)`
Executes a shell command.
- Returns: `Promise<{ stdout: string, stderr: string, exitCode: number }>`

### `vm.stop()`
Terminates the VM.

## Vercel AI SDK Example

See `example/vercel-agent.js` for an example of how to use AgentVM as a tool for an AI agent.
