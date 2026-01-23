#!/usr/bin/env node
/**
 * Profiling script for download performance
 * 
 * Usage:
 *   # Generate flame graph with 0x:
 *   npx 0x test/network/profile-flame.js
 *   
 *   # Use clinic flame (more detailed):
 *   npx clinic flame -- node test/network/profile-flame.js
 *   
 *   # Use clinic doctor (detect issues):
 *   npx clinic doctor -- node test/network/profile-flame.js
 *   
 *   # Built-in V8 profiler:
 *   node --prof test/network/profile-flame.js
 *   node --prof-process isolate-*.log > profile.txt
 */

const { AgentVM } = require('../../src/index');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration
const SIZE_MB = parseInt(process.env.SIZE_MB || '10');
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '0');  // 0 = unlimited
const DEST = process.env.DEST || '/dev/null';  // '/dev/null', '/tmp/test.bin', '/mnt/host/test.bin'
const USE_MOUNT = process.env.USE_MOUNT === '1';

const DOWNLOAD_DIR = path.join(__dirname, '../../test-mount/downloads');

async function main() {
    const size = SIZE_MB * 1024 * 1024;
    
    console.log(`=== Profiling Download ===`);
    console.log(`Size: ${SIZE_MB}MB`);
    console.log(`Rate limit: ${RATE_LIMIT > 0 ? (RATE_LIMIT / 1024) + 'KB/s' : 'unlimited'}`);
    console.log(`Destination: ${DEST}`);
    console.log(`Mount: ${USE_MOUNT ? DOWNLOAD_DIR : 'none'}`);
    
    // Ensure download dir exists
    if (USE_MOUNT) {
        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        }
        // Clean
        fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f)));
    }
    
    // Create server
    const server = http.createServer((req, res) => {
        console.log(`[Server] Serving ${SIZE_MB}MB`);
        res.writeHead(200, { 'Content-Length': size, 'Connection': 'close' });
        
        let remaining = size;
        function send() {
            while (remaining > 0) {
                const chunk = crypto.randomBytes(Math.min(64 * 1024, remaining));
                remaining -= chunk.length;
                if (!res.write(chunk)) { 
                    res.once('drain', send); 
                    return; 
                }
            }
            res.end();
            console.log(`[Server] Done`);
        }
        send();
    });
    
    await new Promise(r => server.listen(18080, '127.0.0.1', r));
    console.log('[Server] Listening on :18080');
    
    // Create VM
    const vmOptions = { 
        network: true, 
        debug: false,
    };
    
    if (USE_MOUNT) {
        vmOptions.mounts = { '/mnt/host': DOWNLOAD_DIR };
    }
    
    const vm = new AgentVM(vmOptions);
    vm.networkRateLimit = RATE_LIMIT;
    
    console.log('[VM] Starting...');
    await vm.start();
    console.log('[VM] Ready');
    
    // Run download
    const startTime = Date.now();
    console.log(`[VM] Downloading to ${DEST}...`);
    
    const result = await vm.exec(`wget -O ${DEST} http://192.168.127.1:18080/data 2>&1`);
    
    const elapsed = (Date.now() - startTime) / 1000;
    const throughput = (SIZE_MB / elapsed).toFixed(2);
    
    console.log(`[VM] Output: ${result.stdout.trim().split('\n').slice(-2).join(' | ')}`);
    console.log(`\n=== Results ===`);
    console.log(`Time: ${elapsed.toFixed(1)}s`);
    console.log(`Throughput: ${throughput} MB/s`);
    
    // Cleanup
    await vm.stop();
    server.close();
    
    console.log('Done');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
