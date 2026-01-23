const { AgentVM } = require('../../src/index');
const assert = require('assert');

/**
 * Large File Download Tests
 * 
 * Tests the TCP flow control mechanisms and buffer management for larger downloads.
 * The network stack uses:
 * - TX_BUFFER_HIGH_WATER: 16KB (triggers pause)
 * - TX_BUFFER_LOW_WATER: 4KB (triggers resume)
 * 
 * These tests verify the VM can handle downloads that exceed these buffer limits.
 */

function withTimeout(promise, ms = 60000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

async function test() {
    console.log("=== Large File Download Tests ===\n");
    console.log("Testing TCP flow control and buffer management for larger downloads.\n");
    
    const vm = new AgentVM({ network: true, debug: false });
    let passed = 0;
    let failed = 0;
    
    try {
        await withTimeout(vm.start(), 15000);
        console.log("VM Started with network enabled.\n");

        // Test 1: Download 1KB file (baseline - within buffer limits)
        console.log("Test 1: Download 1KB file (baseline)");
        let start = Date.now();
        let res = await withTimeout(
            vm.exec("wget -q -O /tmp/1kb.bin http://httpbin.org/bytes/1024 && wc -c < /tmp/1kb.bin"),
            30000
        );
        let elapsed = Date.now() - start;
        const size1kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size1kb === 1024) {
            console.log(`  PASS (${elapsed}ms) - Downloaded ${size1kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 1024 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 2: Download 8KB file (half the high water mark)
        console.log("Test 2: Download 8KB file (half high water mark)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/8kb.bin http://httpbin.org/bytes/8192 && wc -c < /tmp/8kb.bin"),
            30000
        );
        elapsed = Date.now() - start;
        const size8kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size8kb === 8192) {
            console.log(`  PASS (${elapsed}ms) - Downloaded ${size8kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 8192 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 3: Download 20KB file (exceeds 16KB high water mark - triggers flow control)
        console.log("Test 3: Download 20KB file (exceeds high water mark - triggers flow control)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/20kb.bin http://httpbin.org/bytes/20480 && wc -c < /tmp/20kb.bin"),
            45000
        );
        elapsed = Date.now() - start;
        const size20kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size20kb === 20480) {
            console.log(`  PASS (${elapsed}ms) - Downloaded ${size20kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 20480 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 4: Download 50KB file (stress flow control)
        console.log("Test 4: Download 50KB file (multiple flow control cycles)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/50kb.bin http://httpbin.org/bytes/51200 && wc -c < /tmp/50kb.bin"),
            60000
        );
        elapsed = Date.now() - start;
        const size50kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size50kb === 51200) {
            console.log(`  PASS (${elapsed}ms) - Downloaded ${size50kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 51200 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 5: Download 100KB file (larger download)
        console.log("Test 5: Download 100KB file (larger download)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/100kb.bin http://httpbin.org/bytes/102400 && wc -c < /tmp/100kb.bin"),
            90000
        );
        elapsed = Date.now() - start;
        const size100kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size100kb === 102400) {
            console.log(`  PASS (${elapsed}ms) - Downloaded ${size100kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 102400 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 6: Download 25KB binary data
        console.log("Test 6: Download 25KB and verify file size");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/25kb.bin http://httpbin.org/bytes/25600 && wc -c < /tmp/25kb.bin"),
            45000
        );
        elapsed = Date.now() - start;
        const size25kb = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && size25kb === 25600) {
            console.log(`  PASS (${elapsed}ms) - Downloaded: ${size25kb} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 25600 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 7: Sequential large downloads (TCP cleanup between connections)
        console.log("Test 7: Sequential large downloads (TCP state cleanup)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/seq1.bin http://httpbin.org/bytes/16384 && wget -q -O /tmp/seq2.bin http://httpbin.org/bytes/16384 && cat /tmp/seq1.bin /tmp/seq2.bin | wc -c"),
            60000
        );
        elapsed = Date.now() - start;
        const seqTotal = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && seqTotal === 32768) {
            console.log(`  PASS (${elapsed}ms) - Two sequential 16KB downloads: ${seqTotal} bytes total\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 32768 total bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 8: Download streamed bytes and verify
        console.log("Test 8: Download 20KB stream-bytes response");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/stream.bin 'http://httpbin.org/stream-bytes/20000?seed=42' && wc -c < /tmp/stream.bin"),
            45000
        );
        elapsed = Date.now() - start;
        const streamSize = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && streamSize === 20000) {
            console.log(`  PASS (${elapsed}ms) - Stream download: ${streamSize} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 20000 bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 9: Multiple downloads in sequence (memory pressure test)
        console.log("Test 9: Four sequential downloads (memory management)");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/m1.bin http://httpbin.org/bytes/5000 && wget -q -O /tmp/m2.bin http://httpbin.org/bytes/10000 && wget -q -O /tmp/m3.bin http://httpbin.org/bytes/15000 && wget -q -O /tmp/m4.bin http://httpbin.org/bytes/20000 && cat /tmp/m1.bin /tmp/m2.bin /tmp/m3.bin /tmp/m4.bin | wc -c"),
            120000
        );
        elapsed = Date.now() - start;
        const multiTotal = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && multiTotal === 50000) {
            console.log(`  PASS (${elapsed}ms) - Multiple downloads: ${multiTotal} bytes total\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 50000 total bytes, got: ${res.stdout.trim()}\n`);
            console.log(`  stderr: ${res.stderr}\n`);
            failed++;
        }

        // Test 10: Large file with output to stdout (pipe test)
        console.log("Test 10: Download 10KB file and pipe through wc");
        start = Date.now();
        res = await withTimeout(
            vm.exec("wget -q -O - http://httpbin.org/bytes/10240 | wc -c"),
            30000
        );
        elapsed = Date.now() - start;
        const pipeSize = parseInt(res.stdout.trim(), 10);
        if (res.exitCode === 0 && pipeSize === 10240) {
            console.log(`  PASS (${elapsed}ms) - Piped download: ${pipeSize} bytes\n`);
            passed++;
        } else {
            console.log(`  FAIL (${elapsed}ms) - Expected 10240 bytes, got: ${res.stdout.trim()}\n`);
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
            console.log("\nAll large download tests passed!");
        }

    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        await vm.stop();
        console.log("\nVM Stopped.");
    }
}

test();
