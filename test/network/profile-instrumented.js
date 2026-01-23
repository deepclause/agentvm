#!/usr/bin/env node
/**
 * Instrumented profiling - adds timing to key operations
 */

const { AgentVM } = require('../../src/index');
const http = require('http');
const crypto = require('crypto');

// Instrumentation
const timings = {
    networkDataReceived: [],
    pollOneoffCalls: [],
    sockRecvCalls: [],
    fdWriteCalls: [],
};

async function main() {
    const SIZE_MB = 2;
    const size = SIZE_MB * 1024 * 1024;
    
    console.log(`=== Instrumented Profiling: ${SIZE_MB}MB to /tmp ===\n`);
    
    // Create server
    const server = http.createServer((req, res) => {
        console.log(`[Server] Starting ${SIZE_MB}MB transfer`);
        const serverStart = Date.now();
        res.writeHead(200, { 'Content-Length': size, 'Connection': 'close' });
        
        let remaining = size;
        let chunks = 0;
        function send() {
            while (remaining > 0) {
                const chunk = crypto.randomBytes(Math.min(64 * 1024, remaining));
                remaining -= chunk.length;
                chunks++;
                if (!res.write(chunk)) { 
                    res.once('drain', send); 
                    return; 
                }
            }
            res.end();
            console.log(`[Server] Done in ${Date.now() - serverStart}ms (${chunks} chunks)`);
        }
        send();
    });
    
    await new Promise(r => server.listen(18080, '127.0.0.1', r));
    
    // Create VM with instrumentation callback
    const vm = new AgentVM({ 
        network: true, 
        debug: true,  // Enable debug to see what's happening
    });
    vm.networkRateLimit = 0;  // Unlimited
    
    // Capture debug messages
    let lastDebug = Date.now();
    let debugCount = 0;
    const originalPostMessage = vm.worker?.postMessage?.bind(vm.worker);
    
    await vm.start();
    
    // Intercept worker messages
    vm.worker.on('message', (msg) => {
        if (msg.type === 'debug') {
            debugCount++;
            const now = Date.now();
            const delta = now - lastDebug;
            
            // Log if there's a significant gap (>100ms) or every 100th message
            if (delta > 100 || debugCount % 100 === 0) {
                console.log(`[+${delta}ms] ${msg.msg.substring(0, 100)}`);
            }
            lastDebug = now;
        }
    });
    
    console.log('[VM] Starting download...\n');
    const startTime = Date.now();
    
    // Use a timeout promise to detect hangs
    const downloadPromise = vm.exec('wget -O /tmp/test.bin http://192.168.127.1:18080/data 2>&1 && ls -la /tmp/test.bin');
    
    // Monitor progress
    const monitor = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Monitor] ${elapsed}s elapsed, ${debugCount} debug messages`);
    }, 5000);
    
    try {
        const result = await Promise.race([
            downloadPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 30s')), 30000))
        ]);
        
        clearInterval(monitor);
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`\n[Result] ${result.stdout.trim().split('\n').slice(-1)[0]}`);
        console.log(`[Result] Time: ${elapsed.toFixed(1)}s, Throughput: ${(SIZE_MB/elapsed).toFixed(2)} MB/s`);
    } catch (e) {
        clearInterval(monitor);
        console.log(`\n[ERROR] ${e.message}`);
        console.log(`[ERROR] Last debug count: ${debugCount}`);
    }
    
    await vm.stop();
    server.close();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
