const { AgentVM } = require('../../src/index');
const assert = require('assert');

/**
 * Quick network connectivity tests - verifies basic network stack functionality
 * These tests use fast endpoints and short timeouts for CI/CD usage
 */

function withTimeout(promise, ms = 15000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

// Skip HTTPS tests if SKIP_HTTPS env var is set (HTTPS may be slow)
const SKIP_HTTPS = process.env.SKIP_HTTPS === '1';

async function test() {
    console.log("=== Quick Network Tests ===\n");
    
    const vm = new AgentVM({ network: true, debug: false });
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    
    try {
        await withTimeout(vm.start(), 10000);
        console.log("VM Started.\n");
        
        // Test 1: Network interface is configured
        console.log("Test 1: Network interface configured");
        let res = await withTimeout(vm.exec("ip addr show eth0"), 5000);
        if (res.exitCode === 0 && res.stdout.includes('192.168.127')) {
            console.log("  PASS: eth0 has IP address\n");
            passed++;
        } else {
            console.log("  FAIL: eth0 not configured\n");
            failed++;
        }

        // Test 2: Default route exists
        console.log("Test 2: Default route exists");
        res = await withTimeout(vm.exec("ip route | grep default"), 5000);
        if (res.exitCode === 0 && res.stdout.includes('default')) {
            console.log("  PASS: Default route configured\n");
            passed++;
        } else {
            console.log("  FAIL: No default route\n");
            failed++;
        }

        // Test 3: DNS resolver configured
        console.log("Test 3: DNS resolver configured");
        res = await withTimeout(vm.exec("cat /etc/resolv.conf"), 5000);
        if (res.stdout.includes('nameserver')) {
            console.log("  PASS: DNS nameserver configured\n");
            passed++;
        } else {
            console.log("  FAIL: No DNS nameserver\n");
            failed++;
        }

        // Test 4: Ping gateway
        console.log("Test 4: Ping gateway (ICMP)");
        res = await withTimeout(vm.exec("ping -c 1 -W 2 192.168.127.1"), 5000);
        if (res.exitCode === 0) {
            console.log("  PASS: Gateway reachable\n");
            passed++;
        } else {
            console.log("  FAIL: Cannot ping gateway\n");
            failed++;
        }

        // Test 5: Simple HTTP download
        console.log("Test 5: HTTP download (httpbin)");
        res = await withTimeout(
            vm.exec("wget -q -O - http://httpbin.org/get 2>&1 | head -c 200"),
            15000
        );
        if (res.stdout.includes('"url"') || res.stdout.includes('"origin"')) {
            console.log("  PASS: HTTP GET successful\n");
            passed++;
        } else {
            console.log(`  FAIL: HTTP GET failed - ${res.stderr || res.stdout}\n`);
            failed++;
        }

        // Test 6: Simple HTTPS download (using Alpine CDN which is more reliable)
        // HTTPS can be slow due to TLS handshake over userspace network stack
        console.log("Test 6: HTTPS download (Alpine CDN)");
        if (SKIP_HTTPS) {
            console.log("  SKIP: HTTPS tests skipped (SKIP_HTTPS=1)\n");
            skipped++;
        } else {
            res = await withTimeout(
                vm.exec("wget -q -O /tmp/https-test.gz https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz && ls -la /tmp/https-test.gz"),
                60000  // HTTPS needs longer timeout
            );
            if (res.exitCode === 0 && res.stdout.includes('https-test.gz')) {
                console.log("  PASS: HTTPS GET successful\n");
                passed++;
            } else {
                console.log(`  FAIL: HTTPS GET failed - ${res.stderr || res.stdout}\n`);
                failed++;
            }
        }

        // Test 7: Download to file and verify
        console.log("Test 7: Download to file");
        res = await withTimeout(
            vm.exec("wget -q -O /tmp/test.json http://httpbin.org/uuid && cat /tmp/test.json"),
            15000
        );
        if (res.exitCode === 0 && res.stdout.includes('"uuid"')) {
            console.log("  PASS: File download successful\n");
            passed++;
        } else {
            console.log(`  FAIL: File download failed\n`);
            failed++;
        }

        // Test 8: Two sequential downloads (tests TCP state management)
        console.log("Test 8: Sequential downloads");
        const start = Date.now();
        res = await withTimeout(
            vm.exec(`
                wget -q -O /tmp/a.txt http://httpbin.org/bytes/100 &&
                wget -q -O /tmp/b.txt http://httpbin.org/bytes/100 &&
                ls -la /tmp/a.txt /tmp/b.txt
            `),
            20000
        );
        const elapsed = Date.now() - start;
        if (res.exitCode === 0 && res.stdout.includes('a.txt') && res.stdout.includes('b.txt')) {
            console.log(`  PASS: Sequential downloads completed in ${elapsed}ms\n`);
            passed++;
        } else {
            console.log(`  FAIL: Sequential downloads failed\n`);
            failed++;
        }

        // Summary
        console.log("=== Test Summary ===");
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        console.log(`Skipped: ${skipped}`);
        
        if (failed > 0) {
            process.exit(1);
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
