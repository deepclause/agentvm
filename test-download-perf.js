const { AgentVM } = require('./src/index');

/**
 * Test download performance to verify networking improvements
 */

async function test() {
    console.log("=== Download Performance Test ===\n");
    
    const vm = new AgentVM({ network: true, debug: false });
    
    try {
        console.log("Starting VM...");
        await vm.start();
        console.log("VM started.\n");
        
        // Test 1: Small file - Alpine APKINDEX (compressed ~500KB)
        console.log("Test 1: Download Alpine APKINDEX (~500KB compressed)");
        let start = Date.now();
        let res = await vm.exec('curl -s https://dl-cdn.alpinelinux.org/alpine/v3.23/community/x86_64/APKINDEX.tar.gz -o /tmp/apkindex.tar.gz && ls -la /tmp/apkindex.tar.gz');
        let elapsed = Date.now() - start;
        console.log(`  Result (${elapsed}ms):`);
        console.log(`  stdout: ${res.stdout}`);
        if (res.stderr) console.log(`  stderr: ${res.stderr}`);
        console.log();
        
        // Test 2: Get file size
        console.log("Test 2: Verify file size");
        res = await vm.exec('wc -c < /tmp/apkindex.tar.gz');
        const size = parseInt(res.stdout.trim(), 10);
        console.log(`  Downloaded ${size} bytes`);
        console.log(`  Speed: ${(size / 1024 / (elapsed / 1000)).toFixed(1)} KB/s\n`);
        
        // Test 3: Test with wget instead of curl
        console.log("Test 3: Download with wget");
        start = Date.now();
        res = await vm.exec('wget -q -O /tmp/apkindex2.tar.gz https://dl-cdn.alpinelinux.org/alpine/v3.23/community/x86_64/APKINDEX.tar.gz');
        elapsed = Date.now() - start;
        console.log(`  Result (${elapsed}ms):`);
        console.log(`  exitCode: ${res.exitCode}`);
        
        res = await vm.exec('wc -c < /tmp/apkindex2.tar.gz');
        const size2 = parseInt(res.stdout.trim(), 10);
        console.log(`  Downloaded ${size2} bytes`);
        console.log(`  Speed: ${(size2 / 1024 / (elapsed / 1000)).toFixed(1)} KB/s\n`);
        
        // Test 4: Download httpbin binary data
        console.log("Test 4: Download 100KB from httpbin");
        start = Date.now();
        res = await vm.exec('curl -s http://httpbin.org/bytes/102400 -o /tmp/100kb.bin && wc -c < /tmp/100kb.bin');
        elapsed = Date.now() - start;
        const size4 = parseInt(res.stdout.trim(), 10);
        console.log(`  Downloaded ${size4} bytes in ${elapsed}ms`);
        console.log(`  Speed: ${(size4 / 1024 / (elapsed / 1000)).toFixed(1)} KB/s\n`);
        
        console.log("=== Tests Complete ===");
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await vm.stop();
    }
}

test();
