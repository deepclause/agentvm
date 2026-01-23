const { AgentVM } = require('../../src/index');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Profile Download Performance
 * 
 * This test adds instrumentation to understand where bottlenecks occur
 * when downloading large files to the VM or mounted filesystem.
 */

const DOWNLOAD_DIR = path.join(__dirname, '../../test-mount/downloads');

async function profileDownload(options = {}) {
    const {
        sizeMB = 10,
        rateLimit = 0,  // 0 = unlimited
        destination = '/dev/null',  // '/dev/null', '/tmp/file', '/mnt/host/file'
        useMount = false,
    } = options;
    
    // Ensure download dir exists
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    
    // Clean up
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
        fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
    }
    
    const size = sizeMB * 1024 * 1024;
    
    // Track server-side timing
    let serverStartTime = 0;
    let serverEndTime = 0;
    let serverBytesSent = 0;
    
    // Create server
    const server = http.createServer((req, res) => {
        console.log(`[Server] Request for ${size} bytes`);
        serverStartTime = Date.now();
        serverBytesSent = 0;
        
        res.writeHead(200, { 'Content-Length': size, 'Connection': 'close' });
        
        const CHUNK_SIZE = 64 * 1024;
        let remaining = size;
        
        function sendChunk() {
            while (remaining > 0) {
                const toWrite = Math.min(CHUNK_SIZE, remaining);
                const chunk = crypto.randomBytes(toWrite);
                remaining -= toWrite;
                serverBytesSent += toWrite;
                
                if (!res.write(chunk)) {
                    res.once('drain', sendChunk);
                    return;
                }
            }
            serverEndTime = Date.now();
            res.end();
            console.log(`[Server] Finished in ${serverEndTime - serverStartTime}ms`);
        }
        sendChunk();
    });
    
    await new Promise(r => server.listen(18080, '127.0.0.1', r));
    
    // Create VM with profiling
    const vmOptions = { 
        network: true, 
        debug: true,  // Enable debug to see poll_oneoff and fd operations
    };
    
    if (rateLimit > 0) {
        vmOptions.networkRateLimit = rateLimit;
    }
    
    if (useMount) {
        vmOptions.mounts = { '/mnt/host': DOWNLOAD_DIR };
    }
    
    console.log(`\n=== Profile Download: ${sizeMB}MB to ${destination} ===`);
    console.log(`Rate limit: ${rateLimit > 0 ? (rateLimit / 1024) + 'KB/s' : 'unlimited'}`);
    console.log(`Mount: ${useMount ? DOWNLOAD_DIR : 'none'}`);
    
    const vm = new AgentVM(vmOptions);
    
    // Set rate limit explicitly (0 = unlimited)
    vm.networkRateLimit = rateLimit;
    
    await vm.start();
    
    // Run wget with verbose timing
    const startTime = Date.now();
    
    const cmd = `time wget -O ${destination} http://192.168.127.1:18080/data 2>&1; echo "EXIT:$?"`;
    console.log(`[VM] Running: ${cmd}`);
    
    const result = await vm.exec(cmd);
    
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const throughput = (sizeMB / (totalTime / 1000)).toFixed(2);
    
    console.log(`\n[VM Output]:\n${result.stdout}`);
    console.log(`\n=== Results ===`);
    console.log(`Total time: ${totalTime}ms`);
    console.log(`Throughput: ${throughput} MB/s`);
    console.log(`Server transfer time: ${serverEndTime - serverStartTime}ms`);
    
    // Check file on host if mounted
    if (useMount && destination.startsWith('/mnt/host/')) {
        const filename = destination.replace('/mnt/host/', '');
        const hostPath = path.join(DOWNLOAD_DIR, filename);
        if (fs.existsSync(hostPath)) {
            const stats = fs.statSync(hostPath);
            console.log(`Host file size: ${stats.size} bytes (expected: ${size})`);
        }
    }
    
    await vm.stop();
    server.close();
    
    return { totalTime, throughput, serverTime: serverEndTime - serverStartTime };
}

async function main() {
    console.log('=== Download Performance Profiling ===\n');
    
    const tests = [
        // First test with /dev/null to isolate network from filesystem
        { sizeMB: 10, rateLimit: 0, destination: '/dev/null', useMount: false, name: '10MB /dev/null (unlimited)' },
        
        // Then test VM internal filesystem at different rates
        { sizeMB: 10, rateLimit: 0, destination: '/tmp/test.bin', useMount: false, name: '10MB VM /tmp (unlimited)' },
        { sizeMB: 10, rateLimit: 1024 * 1024, destination: '/tmp/test.bin', useMount: false, name: '10MB VM /tmp (1MB/s)' },
        { sizeMB: 10, rateLimit: 512 * 1024, destination: '/tmp/test.bin', useMount: false, name: '10MB VM /tmp (512KB/s)' },
        
        // Then test mounted host filesystem
        { sizeMB: 10, rateLimit: 0, destination: '/mnt/host/test.bin', useMount: true, name: '10MB mounted (unlimited)' },
        { sizeMB: 10, rateLimit: 2 * 1024 * 1024, destination: '/mnt/host/test.bin', useMount: true, name: '10MB mounted (2MB/s)' },
        { sizeMB: 10, rateLimit: 1024 * 1024, destination: '/mnt/host/test.bin', useMount: true, name: '10MB mounted (1MB/s)' },
    ];
    
    const results = [];
    
    for (const test of tests) {
        try {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`TEST: ${test.name}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await profileDownload(test);
            results.push({ name: test.name, ...result, success: true });
            
            // Small delay between tests
            await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
            console.error(`FAILED: ${err.message}`);
            results.push({ name: test.name, success: false, error: err.message });
        }
    }
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    for (const r of results) {
        if (r.success) {
            console.log(`${r.name}: ${r.totalTime}ms (${r.throughput} MB/s)`);
        } else {
            console.log(`${r.name}: FAILED - ${r.error}`);
        }
    }
}

// Allow running individual test
if (process.argv[2] === '--quick') {
    // Quick test: just /dev/null unlimited
    profileDownload({ sizeMB: 5, rateLimit: 0, destination: '/dev/null' })
        .then(() => process.exit(0))
        .catch(e => { console.error(e); process.exit(1); });
} else if (process.argv[2] === '--mount') {
    // Test mounted filesystem
    profileDownload({ sizeMB: 10, rateLimit: 2 * 1024 * 1024, destination: '/mnt/host/test.bin', useMount: true })
        .then(() => process.exit(0))
        .catch(e => { console.error(e); process.exit(1); });
} else {
    main().catch(e => { console.error(e); process.exit(1); });
}
