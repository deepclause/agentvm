/**
 * Focused Network State Diagnostic
 * Tests DNS and connection state throughout the session
 */

const { AgentVM } = require('./src/index');

async function main() {
    console.log('=== Network State Diagnostic ===\n');

    const vm = new AgentVM({ network: true, debug: false });
    await vm.start();

    const tests = [
        // Initial state
        { name: 'Initial DNS (httpbin)', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        { name: 'Initial DNS (tele2)', cmd: 'nslookup speedtest.tele2.net 2>&1 | head -5' },
        
        // Small HTTP test
        { name: 'HTTP small (100 bytes)', cmd: 'wget -q -O - http://httpbin.org/bytes/100 | wc -c' },
        
        // Check DNS after first request
        { name: 'DNS after HTTP (httpbin)', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        
        // Another small HTTP
        { name: 'HTTP small #2 (100 bytes)', cmd: 'wget -q -O - http://httpbin.org/bytes/100 | wc -c' },
        
        // Check DNS again
        { name: 'DNS check #3', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        
        // Medium download
        { name: 'HTTP 10KB', cmd: 'wget -q -O - http://httpbin.org/bytes/10240 | wc -c' },
        
        // DNS after medium
        { name: 'DNS after 10KB', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        
        // 50KB download
        { name: 'HTTP 50KB', cmd: 'wget -q -O - http://httpbin.org/bytes/51200 | wc -c' },
        
        // DNS after 50KB
        { name: 'DNS after 50KB', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        
        // 100KB download (httpbin max)
        { name: 'HTTP 100KB', cmd: 'wget -q -O - http://httpbin.org/bytes/102400 | wc -c' },
        
        // DNS after 100KB
        { name: 'DNS after 100KB', cmd: 'nslookup httpbin.org 2>&1 | head -5' },
        { name: 'DNS tele2 after 100KB', cmd: 'nslookup speedtest.tele2.net 2>&1 | head -5' },
        
        // Now try tele2 download
        { name: 'HTTP 512KB (tele2)', cmd: 'wget -q -O /dev/null http://speedtest.tele2.net/512KB.zip && echo "OK" || echo "FAILED"' },
    ];

    for (const test of tests) {
        process.stdout.write(`[${test.name}] ... `);
        const start = Date.now();
        try {
            const result = await Promise.race([
                vm.exec(test.cmd),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000))
            ]);
            const elapsed = Date.now() - start;
            const output = result.stdout.trim().replace(/\n/g, ' | ');
            console.log(`(${elapsed}ms) exit=${result.exitCode} => ${output.substring(0, 80)}`);
        } catch (e) {
            const elapsed = Date.now() - start;
            console.log(`(${elapsed}ms) ERROR: ${e.message}`);
        }
    }

    await vm.stop();
}

main().catch(console.error);
