#!/usr/bin/env node

const { AgentVM } = require('../src/index.js');
const path = require('node:path');

function printUsage() {
    console.log(`
AgentVM CLI - Interactive terminal into the VM

Usage: agentvm [options]

Options:
  --network, -n          Enable networking (default: enabled)
  --no-network           Disable networking
  --mount, -m <path>     Mount a host directory into the VM at /mnt/host
                         Can specify VM path with: --mount /host/path:/vm/path
  --debug, -d            Enable debug logging
  --help, -h             Show this help message

Examples:
  agentvm                           # Start VM with networking enabled
  agentvm --no-network              # Start VM without networking
  agentvm -m /home/user/project     # Mount directory at /mnt/host
  agentvm -m /tmp/data:/data        # Mount /tmp/data at /data in VM
  agentvm -n -m ./mydir             # Network on, mount ./mydir
`);
}

function parseArgs(args) {
    const options = {
        network: true,
        mounts: {},
        debug: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
                break;

            case '--network':
            case '-n':
                options.network = true;
                break;

            case '--no-network':
                options.network = false;
                break;

            case '--mount':
            case '-m':
                const mountArg = args[++i];
                if (!mountArg) {
                    console.error('Error: --mount requires a path argument');
                    process.exit(1);
                }
                
                // Support both "/host/path" and "/host/path:/vm/path" formats
                if (mountArg.includes(':') && !mountArg.startsWith('/') || mountArg.split(':').length > 2) {
                    // Handle Windows-style paths or explicit VM path
                    const lastColon = mountArg.lastIndexOf(':');
                    if (lastColon > 0 && mountArg[lastColon - 1] !== '\\') {
                        const hostPath = mountArg.substring(0, lastColon);
                        const vmPath = mountArg.substring(lastColon + 1);
                        options.mounts[vmPath] = path.resolve(hostPath);
                    } else {
                        options.mounts['/mnt/host'] = path.resolve(mountArg);
                    }
                } else if (mountArg.includes(':')) {
                    const [hostPath, vmPath] = mountArg.split(':');
                    options.mounts[vmPath] = path.resolve(hostPath);
                } else {
                    options.mounts['/mnt/host'] = path.resolve(mountArg);
                }
                break;

            case '--debug':
            case '-d':
                options.debug = true;
                break;

            default:
                if (arg.startsWith('-')) {
                    console.error(`Unknown option: ${arg}`);
                    printUsage();
                    process.exit(1);
                }
                break;
        }
    }

    return options;
}

async function main() {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    // Print startup info to stderr so it doesn't interfere with VM output
    process.stderr.write('AgentVM Terminal\n');
    process.stderr.write('================\n');
    process.stderr.write(`Network: ${options.network ? 'enabled' : 'disabled'}\n`);
    
    if (Object.keys(options.mounts).length > 0) {
        process.stderr.write('Mounts:\n');
        for (const [vmPath, hostPath] of Object.entries(options.mounts)) {
            process.stderr.write(`  ${hostPath} -> ${vmPath}\n`);
        }
    }
    process.stderr.write('\n');

    const vm = new AgentVM({
        network: options.network,
        mounts: options.mounts,
        debug: options.debug,
        interactive: true,  // Use interactive/raw mode
    });

    // Connect VM stdout/stderr directly to process stdout/stderr
    vm.onStdout = (data) => {
        process.stdout.write(data);
    };
    
    vm.onStderr = (data) => {
        process.stderr.write(data);
    };

    // Handle VM exit (e.g., user types 'exit' in shell)
    vm.onExit = async () => {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.exit(0);
    };

    process.stderr.write('Booting VM...\n');
    
    try {
        await vm.start();
    } catch (err) {
        process.stderr.write(`Failed to start VM: ${err.message}\n`);
        process.exit(1);
    }

    process.stderr.write('VM Ready. Press Ctrl+D to exit.\n\n');

    // Put stdin in raw mode for true terminal experience
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Pipe stdin directly to VM
    process.stdin.on('data', async (data) => {
        // Check for Ctrl+D (EOF) - exit cleanly
        if (data.length === 1 && data[0] === 0x04) {
            process.stderr.write('\n\nShutting down VM...\n');
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            await vm.stop();
            process.exit(0);
        }
        
        try {
            await vm.writeToStdin(data);
        } catch (err) {
            if (options.debug) {
                process.stderr.write(`Error writing to VM: ${err.message}\n`);
            }
        }
    });

    // Handle stdin close
    process.stdin.on('end', async () => {
        process.stderr.write('\n\nShutting down VM...\n');
        await vm.stop();
        process.exit(0);
    });

    // Handle Ctrl+C - pass it through to VM unless pressed twice
    let ctrlCCount = 0;
    let ctrlCTimer = null;
    
    process.on('SIGINT', async () => {
        ctrlCCount++;
        
        if (ctrlCCount >= 2) {
            process.stderr.write('\n\nForce shutting down VM...\n');
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            await vm.stop();
            process.exit(0);
        }
        
        // Send Ctrl+C to VM
        try {
            await vm.writeToStdin('\x03');
        } catch (err) {
            // Ignore
        }
        
        // Reset counter after a delay
        clearTimeout(ctrlCTimer);
        ctrlCTimer = setTimeout(() => {
            ctrlCCount = 0;
        }, 500);
    });

    // Handle process termination
    process.on('SIGTERM', async () => {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        await vm.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
