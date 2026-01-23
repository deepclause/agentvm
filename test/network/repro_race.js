const { AgentVM } = require('../../src/index');

async function test() {
    console.log("=== Network Race Condition Repro ===\n");
    
    const vm = new AgentVM({ network: true, debug: true }); 
    
    try {
        await vm.start();
        console.log("VM Started.\n");
        
        const ITERATIONS = 2;
        let failures = 0;
        let successes = 0;

        console.log(`Starting ${ITERATIONS} requests...`);
        
        for (let i = 0; i < ITERATIONS; i++) {
            console.log(`\n--- Request ${i+1}/${ITERATIONS} ---`);
            
            // Use curl with HTTPS for google.com
            const cmd = `curl -sL https://www.google.com/`;
            
            try {
                // Timeout of 30s per request for HTTPS/TLS
                const res = await Promise.race([
                    vm.exec(cmd),
                    new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 30000))
                ]);

                if (res.exitCode === 0 && (res.stdout.includes('<html') || res.stdout.includes('<!doctype'))) {
                    successes++;
                } else {
                    failures++;
                    console.log(`\nFailed iter ${i}: exit=${res.exitCode} stderr=${res.stderr} stdout=${res.stdout}`);
                }
            } catch (err) {
                failures++;
                console.log(`\nFailed iter ${i}: ${err.message}`);
            }
            
            // Small delay to be polite to the server, but fast enough to trigger races if they are internal
            await new Promise(r => setTimeout(r, 100));
        }
        
        console.log(`\n\nResults: ${successes} passed, ${failures} failed.`);
        
        if (failures > 0) {
            console.log("BUG REPRODUCED: Intermittent failures detected.");
            process.exit(1);
        } else {
            console.log("No failures detected. Bug might be rarer or conditions not met.");
        }

    } catch (e) {
        console.error("\nTEST FAILED (Global):", e);
        process.exit(1);
    } finally {
        await vm.stop();
    }
}

test();
