/**
 * VM Diagnostic Test Suite
 * 
 * Systematically tests different VM components to isolate issues:
 * 1. Memory allocation
 * 2. File I/O throughput
 * 3. Network socket behavior
 * 4. Download size boundaries
 */

const { AgentVM } = require('./src/index');

const TIMEOUT_MS = 60000;

async function runTest(name, vm, cmd, timeout = TIMEOUT_MS) {
    const start = Date.now();
    try {
        const res = await Promise.race([
            vm.exec(cmd),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout))
        ]);
        const elapsed = Date.now() - start;
        return { name, success: res.exitCode === 0, elapsed, output: res.stdout.trim(), exitCode: res.exitCode };
    } catch (e) {
        const elapsed = Date.now() - start;
        return { name, success: false, elapsed, output: e.message, exitCode: -1 };
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('VM DIAGNOSTIC TEST SUITE');
    console.log('='.repeat(60));
    console.log();

    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();

    const results = [];

    // =========================================
    // SECTION 1: Memory Tests
    // =========================================
    console.log('--- SECTION 1: Memory Tests ---\n');

    // Test 1.1: Check available memory
    results.push(await runTest('1.1 Memory Info', vm, 'free -m | head -2'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output.split('\n')[1] || results.at(-1).output}`);

    // Test 1.2: Allocate 10MB in memory
    results.push(await runTest('1.2 Allocate 10MB RAM', vm, 
        'dd if=/dev/zero bs=1M count=10 2>/dev/null | wc -c'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} bytes`);

    // Test 1.3: Allocate 50MB in memory
    results.push(await runTest('1.3 Allocate 50MB RAM', vm,
        'dd if=/dev/zero bs=1M count=50 2>/dev/null | wc -c'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} bytes`);

    console.log();

    // =========================================
    // SECTION 2: File I/O Tests
    // =========================================
    console.log('--- SECTION 2: File I/O Tests ---\n');

    // Test 2.1: Write 10MB to /tmp
    results.push(await runTest('2.1 Write 10MB to disk', vm,
        'dd if=/dev/zero of=/tmp/test10m bs=1M count=10 2>&1 | tail -1'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output}`);

    // Test 2.2: Read 10MB from disk
    results.push(await runTest('2.2 Read 10MB from disk', vm,
        'dd if=/tmp/test10m of=/dev/null bs=1M 2>&1 | tail -1'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output}`);

    // Test 2.3: Verify file size
    results.push(await runTest('2.3 Verify file size', vm,
        'wc -c < /tmp/test10m'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} bytes`);

    // Cleanup
    await vm.exec('rm -f /tmp/test10m');

    console.log();

    // =========================================
    // SECTION 3: Network Stack Tests
    // =========================================
    console.log('--- SECTION 3: Network Stack Tests ---\n');

    // Test 3.1: DNS resolution
    results.push(await runTest('3.1 DNS Resolution', vm,
        'nslookup httpbin.org 2>/dev/null | grep -A1 "Name:" | tail -1 || echo "DNS failed"'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output}`);

    // Test 3.2: TCP connection (small request)
    results.push(await runTest('3.2 TCP Small Request', vm,
        'wget -q -O - http://httpbin.org/get 2>/dev/null | head -1'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output}`);

    // Test 3.3: TCP with response body check
    results.push(await runTest('3.3 TCP Response Integrity', vm,
        'wget -q -O - http://httpbin.org/bytes/1024 2>/dev/null | wc -c'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} bytes (expected: 1024)`);

    console.log();

    // =========================================
    // SECTION 4: Download Size Boundary Tests
    // =========================================
    console.log('--- SECTION 4: Download Size Boundary Tests ---\n');

    const downloadSizes = [
        { size: '512KB', url: 'http://speedtest.tele2.net/512KB.zip', expected: 524288 },
        { size: '1MB', url: 'http://speedtest.tele2.net/1MB.zip', expected: 1048576 },
        { size: '3MB', url: 'http://speedtest.tele2.net/3MB.zip', expected: 3145728 },
        { size: '5MB', url: 'http://speedtest.tele2.net/5MB.zip', expected: 5242880 },
        { size: '10MB', url: 'http://speedtest.tele2.net/10MB.zip', expected: 10485760 },
    ];

    for (const dl of downloadSizes) {
        const testName = `4.x Download ${dl.size}`;
        const result = await runTest(testName, vm,
            `wget -q -O /tmp/dl_test ${dl.url} && wc -c < /tmp/dl_test && rm -f /tmp/dl_test`,
            90000); // 90s timeout for larger files
        
        const gotBytes = parseInt(result.output) || 0;
        const sizeMatch = gotBytes === dl.expected;
        result.success = result.success && sizeMatch;
        result.details = `got ${gotBytes}, expected ${dl.expected}`;
        
        results.push(result);
        const status = result.success ? 'PASS' : (result.output === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL');
        console.log(`[${status}] ${testName}: ${result.details} (${result.elapsed}ms)`);
        
        // If this size failed, no point testing larger
        if (!result.success) {
            console.log(`    ^ Stopping size tests here - found boundary`);
            break;
        }
    }

    console.log();

    // =========================================
    // SECTION 5: Stress Tests
    // =========================================
    console.log('--- SECTION 5: Stress Tests ---\n');

    // Test 5.1: Multiple small downloads sequentially
    results.push(await runTest('5.1 Sequential Downloads (3x100KB)', vm,
        'for i in 1 2 3; do wget -q -O /dev/null http://httpbin.org/bytes/102400; done && echo "OK"'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} (${results.at(-1).elapsed}ms)`);

    // Test 5.2: Memory after downloads
    results.push(await runTest('5.2 Memory After Tests', vm, 'free -m | head -2'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output.split('\n')[1] || results.at(-1).output}`);

    console.log();

    // =========================================
    // SECTION 6: Process State Tests
    // =========================================
    console.log('--- SECTION 6: Process State Tests ---\n');

    // Test 6.1: Check for zombie processes
    results.push(await runTest('6.1 Zombie Processes', vm,
        'ps aux 2>/dev/null | grep -c "Z" || echo "0"'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} zombies`);

    // Test 6.2: Open file descriptors (if /proc available)
    results.push(await runTest('6.2 Open FDs', vm,
        'ls /proc/self/fd 2>/dev/null | wc -l || echo "N/A"'));
    console.log(`[${results.at(-1).success ? 'PASS' : 'FAIL'}] ${results.at(-1).name}: ${results.at(-1).output} open fds`);

    await vm.stop();

    // =========================================
    // SUMMARY
    // =========================================
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    
    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`Total: ${results.length} tests, ${passed} passed, ${failed} failed\n`);
    
    if (failed > 0) {
        console.log('Failed tests:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`  - ${r.name}: ${r.output} (${r.elapsed}ms)`);
        });
    }

    // Find download boundary
    const downloadResults = results.filter(r => r.name.startsWith('4.x'));
    const lastSuccess = downloadResults.filter(r => r.success).pop();
    const firstFailure = downloadResults.find(r => !r.success);
    
    if (lastSuccess && firstFailure) {
        console.log(`\nDownload size boundary: Works up to ${lastSuccess.name.split(' ')[2]}, fails at ${firstFailure.name.split(' ')[2]}`);
    } else if (!firstFailure) {
        console.log('\nAll download sizes passed!');
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Diagnostic failed:', e);
    process.exit(1);
});
