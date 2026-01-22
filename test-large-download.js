/**
 * Large Download Debug Test
 * Tests what happens during larger downloads
 */

const { AgentVM } = require('./src/index');

async function main() {
    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();
    
    console.log('Testing incremental download sizes with httpbin (max 100KB)...\n');
    
    const sizes = [50000, 75000, 100000, 102400];
    
    for (const size of sizes) {
        process.stdout.write(`HTTP ${(size/1024).toFixed(1)}KB... `);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(`wget -q -O - http://httpbin.org/bytes/${size} | wc -c`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
            ]);
            const elapsed = Date.now() - start;
            const got = parseInt(result.stdout.trim()) || 0;
            console.log(`${got === size ? 'PASS' : 'FAIL'} - got ${got} bytes in ${elapsed}ms`);
        } catch (e) {
            const elapsed = Date.now() - start;
            console.log(`ERROR: ${e.message} after ${elapsed}ms`);
        }
    }
    
    console.log('\nTesting tele2 speedtest downloads...\n');
    
    const tele2Sizes = [
        { name: '512KB', url: 'http://speedtest.tele2.net/512KB.zip', expected: 524288 },
        { name: '1MB', url: 'http://speedtest.tele2.net/1MB.zip', expected: 1048576 },
    ];
    
    for (const dl of tele2Sizes) {
        process.stdout.write(`Tele2 ${dl.name}... `);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(`wget -q -O /tmp/dl ${dl.url} && wc -c < /tmp/dl && rm /tmp/dl`),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000))
            ]);
            const elapsed = Date.now() - start;
            const got = parseInt(result.stdout.trim()) || 0;
            console.log(`${got === dl.expected ? 'PASS' : 'FAIL'} - got ${got} bytes in ${elapsed}ms`);
        } catch (e) {
            const elapsed = Date.now() - start;
            console.log(`ERROR: ${e.message} after ${elapsed}ms`);
        }
    }
    
    // Now test with status output to see progress
    console.log('\nTesting 1MB with verbose wget (limited time)...\n');
    
    try {
        const result = await Promise.race([
            vm.exec('timeout 20 wget -O /tmp/dl http://speedtest.tele2.net/1MB.zip 2>&1; ls -la /tmp/dl 2>&1 || echo "No file"'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OUTER TIMEOUT')), 30000))
        ]);
        console.log('Result:', result.stdout);
    } catch (e) {
        console.log('Error:', e.message);
    }
    
    await vm.stop();
}

main().catch(console.error);
