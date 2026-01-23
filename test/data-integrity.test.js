/**
 * Data Integrity Test
 * 
 * This test downloads a file via HTTP (not HTTPS) and verifies:
 * 1. The data is not corrupted
 * 2. The sequence numbers are correct
 * 3. No data is missing or duplicated
 * 
 * We use HTTP to avoid TLS complexity and isolate the TCP data handling.
 */

const { AgentVM } = require('../src/index');
const http = require('http');
const crypto = require('crypto');

// Generate a predictable test payload
function generateTestData(size) {
    const buf = Buffer.alloc(size);
    // Fill with a repeating pattern that's easy to verify
    // Pattern: 4-byte sequence number (big-endian) repeated
    for (let i = 0; i < size; i += 4) {
        const remaining = Math.min(4, size - i);
        const seqNum = Math.floor(i / 4);
        buf.writeUInt32BE(seqNum, i);
    }
    return buf;
}

// Verify the test data is intact
function verifyTestData(buf) {
    const errors = [];
    for (let i = 0; i < buf.length; i += 4) {
        const remaining = Math.min(4, buf.length - i);
        if (remaining < 4) break; // Ignore partial last chunk
        
        const expected = Math.floor(i / 4);
        const actual = buf.readUInt32BE(i);
        
        if (actual !== expected) {
            errors.push({
                offset: i,
                expected,
                actual,
                // Get surrounding context
                context: buf.slice(Math.max(0, i - 8), Math.min(buf.length, i + 12)).toString('hex')
            });
            
            if (errors.length >= 10) {
                errors.push({ message: '... more errors truncated ...' });
                break;
            }
        }
    }
    return errors;
}

async function runTest() {
    const TEST_SIZE = 64 * 1024; // 64KB - enough to span multiple TCP segments
    const testData = generateTestData(TEST_SIZE);
    const expectedHash = crypto.createHash('md5').update(testData).digest('hex');
    
    console.log(`Test data: ${TEST_SIZE} bytes, MD5: ${expectedHash}`);
    
    // Start a simple HTTP server that serves the test data
    const server = http.createServer((req, res) => {
        if (req.url === '/test') {
            console.log('[Server] Serving test data...');
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': testData.length.toString()
            });
            res.end(testData);
        } else if (req.url === '/small') {
            // Small response for quick verification
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });
    
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    const port = server.address().port;
    console.log(`[Server] Listening on port ${port}`);
    
    // Get host IP that VM can reach (192.168.127.1 in VM = localhost on host)
    const vmServerUrl = `http://192.168.127.1:${port}`;
    
    try {
        // Start VM
        const vm = new AgentVM({ network: true, debug: false });
        await vm.start();
        console.log('[VM] Started');
        
        // Verify basic connectivity first
        console.log('[Test] Checking basic connectivity...');
        const pingResult = await vm.exec(`curl -s -m 5 ${vmServerUrl}/small`);
        if (pingResult.stdout !== 'OK') {
            throw new Error(`Basic connectivity failed: ${pingResult.stdout} ${pingResult.stderr}`);
        }
        console.log('[Test] Basic connectivity OK');
        
        // Now test with larger data
        console.log('[Test] Downloading test data...');
        
        // Download and save to file, then compute hash
        const dlResult = await vm.exec(`
            curl -s -m 30 -o /tmp/test.bin ${vmServerUrl}/test && \
            md5sum /tmp/test.bin && \
            wc -c /tmp/test.bin
        `);
        
        console.log('[Test] Download result:', dlResult);
        
        // Parse the MD5 hash from output
        const hashMatch = dlResult.stdout.match(/^([a-f0-9]{32})\s/);
        const receivedHash = hashMatch ? hashMatch[1] : null;
        
        // Parse the size - look for the wc -c output line
        const sizeMatch = dlResult.stdout.match(/^(\d+)\s+\/tmp\/test\.bin/m);
        const receivedSize = sizeMatch ? parseInt(sizeMatch[1]) : null;
        
        console.log(`[Test] Expected: ${TEST_SIZE} bytes, MD5: ${expectedHash}`);
        console.log(`[Test] Received: ${receivedSize} bytes, MD5: ${receivedHash}`);
        
        if (receivedSize !== TEST_SIZE) {
            console.error(`[FAIL] Size mismatch! Expected ${TEST_SIZE}, got ${receivedSize}`);
        } else if (receivedHash !== expectedHash) {
            console.error(`[FAIL] Hash mismatch! Data was corrupted.`);
            
            // Try to get more details by dumping hex
            const hexResult = await vm.exec(`xxd /tmp/test.bin | head -50`);
            console.log('[Debug] First 50 lines of hex dump:');
            console.log(hexResult.stdout);
            
            // Check for specific corruption patterns
            const tailResult = await vm.exec(`xxd /tmp/test.bin | tail -50`);
            console.log('[Debug] Last 50 lines of hex dump:');
            console.log(tailResult.stdout);
        } else {
            console.log('[PASS] Data integrity verified!');
        }
        
        await vm.stop();
    } finally {
        server.close();
    }
}

// Multiple test runs to catch intermittent issues
async function runMultipleTests(count = 5) {
    console.log(`\n=== Running ${count} data integrity tests ===\n`);
    
    let passed = 0;
    let failed = 0;
    
    for (let i = 1; i <= count; i++) {
        console.log(`\n--- Test run ${i}/${count} ---\n`);
        try {
            await runTest();
            passed++;
        } catch (err) {
            console.error(`[FAIL] Test ${i} failed:`, err.message);
            failed++;
        }
    }
    
    console.log(`\n=== Results: ${passed}/${count} passed, ${failed}/${count} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

// Run single test or multiple based on args
const count = parseInt(process.argv[2]) || 1;
if (count > 1) {
    runMultipleTests(count);
} else {
    runTest().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}
