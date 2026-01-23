const { AgentVM } = require('../../src/index');
const http = require('http');
const crypto = require('crypto');

/**
 * Large File Download Tests (1MB, 10MB, 50MB)
 * 
 * Uses a local HTTP server to test downloading large files into the VM filesystem.
 * This tests the TCP flow control and buffer management at scale.
 * 
 * Note: The VM has limited disk space (~56MB), so we test up to 50MB.
 * The VM has built-in network rate limiting (default 256KB/s) to prevent
 * overwhelming the filesystem writes.
 */

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

// Create a local HTTP server that serves files of specified sizes
// No rate limiting - relies on VM's built-in network rate limiting
function createTestServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // Parse URL to get requested size: /bytes/<size>
            const match = req.url.match(/^\/bytes\/(\d+)$/);
            if (!match) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            
            const size = parseInt(match[1], 10);
            console.log(`  [Server] Serving ${(size / 1024 / 1024).toFixed(2)}MB`);
            
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': size,
                'Connection': 'close'
            });
            
            // Stream data in chunks, but as fast as TCP allows (no artificial rate limiting)
            const CHUNK_SIZE = 64 * 1024;  // 64KB chunks
            let remaining = size;
            
            function sendChunk() {
                while (remaining > 0) {
                    const toWrite = Math.min(CHUNK_SIZE, remaining);
                    const chunk = crypto.randomBytes(toWrite);
                    remaining -= toWrite;
                    
                    if (!res.write(chunk)) {
                        // TCP backpressure - wait for drain
                        res.once('drain', sendChunk);
                        return;
                    }
                }
                res.end();
                console.log(`  [Server] Finished sending ${size} bytes`);
            }
            
            sendChunk();
        });
        
        server.listen(port, '127.0.0.1', () => {
            console.log(`  [Server] Test server listening on http://127.0.0.1:${port}`);
            resolve(server);
        });
        
        server.on('error', reject);
    });
}

async function test() {
    console.log("=== Very Large File Download Tests ===\n");
    console.log("Testing 1MB, 10MB, and 50MB downloads via local HTTP server.");
    console.log("(Using VM's built-in rate limiting at 256KB/s)\n");
    
    const PORT = 18080;
    let server;
    let vm;
    let passed = 0;
    let failed = 0;
    
    try {
        // Start local test server
        console.log("Starting local HTTP server...");
        server = await createTestServer(PORT);
        
        // Start VM with network - uses default 256KB/s rate limit
        console.log("Starting VM...");
        vm = new AgentVM({ network: true, debug: false });
        await withTimeout(vm.start(), 15000);
        console.log("VM Started with network enabled.\n");

        // Test 1: Download 1MB file
        console.log("Test 1: Download 1MB file");
        const size1mb = 1 * 1024 * 1024;
        let start = Date.now();
        let res = await withTimeout(
            vm.exec(`rm -f /tmp/*.bin; wget -q -O /tmp/1mb.bin http://192.168.127.1:${PORT}/bytes/${size1mb} && wc -c < /tmp/1mb.bin`),
            120000  // 2 minute timeout
        );
        let elapsed = Date.now() - start;
        let downloadedSize = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && downloadedSize === size1mb) {
            const speedMbps = (size1mb / 1024 / 1024) / (elapsed / 1000);
            console.log(`  PASS (${elapsed}ms) - Downloaded ${downloadedSize} bytes (${speedMbps.toFixed(2)} MB/s)\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected ${size1mb} bytes, got: ${res.stdout.trim()}`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 2: Download 10MB file
        console.log("Test 2: Download 10MB file");
        const size10mb = 10 * 1024 * 1024;
        start = Date.now();
        res = await withTimeout(
            vm.exec(`rm -f /tmp/1mb.bin; wget -q -O /tmp/10mb.bin http://192.168.127.1:${PORT}/bytes/${size10mb} && wc -c < /tmp/10mb.bin`),
            300000  // 5 minute timeout
        );
        elapsed = Date.now() - start;
        downloadedSize = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && downloadedSize === size10mb) {
            const speedMbps = (size10mb / 1024 / 1024) / (elapsed / 1000);
            console.log(`  PASS (${elapsed}ms) - Downloaded ${downloadedSize} bytes (${speedMbps.toFixed(2)} MB/s)\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected ${size10mb} bytes, got: ${res.stdout.trim()}`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 3: Download 50MB file (near VM disk limit)
        console.log("Test 3: Download 50MB file");
        const size50mb = 50 * 1024 * 1024;
        start = Date.now();
        res = await withTimeout(
            vm.exec(`rm -f /tmp/10mb.bin; wget -q -O /tmp/50mb.bin http://192.168.127.1:${PORT}/bytes/${size50mb} && wc -c < /tmp/50mb.bin`),
            600000  // 10 minute timeout
        );
        elapsed = Date.now() - start;
        downloadedSize = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && downloadedSize === size50mb) {
            const speedMbps = (size50mb / 1024 / 1024) / (elapsed / 1000);
            console.log(`  PASS (${elapsed}ms) - Downloaded ${downloadedSize} bytes (${speedMbps.toFixed(2)} MB/s)\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected ${size50mb} bytes, got: ${res.stdout.trim()}`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 4: Verify final file exists and check disk usage
        console.log("Test 4: Verify final file and disk usage");
        start = Date.now();
        res = await withTimeout(
            vm.exec("ls -la /tmp/50mb.bin && df -h /"),
            30000
        );
        elapsed = Date.now() - start;
        if (res.exitCode === 0 && res.stdout.includes('50mb.bin') && res.stdout.includes('52428800')) {
            console.log(`  PASS (${elapsed}ms) - 50MB file verified`);
            console.log(`  Output:\n${res.stdout}\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - File verification failed`);
            console.log(`  stdout: ${res.stdout}`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Summary
        console.log("=== Test Summary ===");
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        console.log(`Total: ${passed + failed}`);
        
        if (failed > 0) {
            console.log("\nSome tests failed!");
            process.exit(1);
        } else {
            console.log("\nAll large file download tests passed!");
        }

    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        if (vm) {
            await vm.stop();
            console.log("\nVM Stopped.");
        }
        if (server) {
            server.close();
            console.log("Test server stopped.");
        }
    }
}

test();
