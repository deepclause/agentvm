const { AgentVM } = require('../src/index.js');
const readline = require('readline');
const path = require('path');

async function main() {
    // Redirect console.log to stderr to keep stdout clean for JSON-RPC
    const originalLog = console.log;
    console.log = console.error;

    const vm = new AgentVM({
        // Point to the WASM file relative to this script
        wasmPath: path.join(__dirname, '../agentvm-alpine-python.wasm')
    });

    try {
        await vm.start();
        // Signal readiness on stdout
        process.stdout.write("READY\n");
    } catch (err) {
        console.error("Failed to start VM:", err);
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', async (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            if (msg.cmd === 'exec') {
                try {
                    const res = await vm.exec(msg.command);
                    process.stdout.write(JSON.stringify({ status: 'ok', result: res }) + "\n");
                } catch (execErr) {
                    process.stdout.write(JSON.stringify({ status: 'error', error: execErr.message }) + "\n");
                }
            } else if (msg.cmd === 'stop') {
                await vm.stop();
                process.exit(0);
            }
        } catch (err) {
            console.error("Bridge Error:", err);
        }
    });
}

main();
