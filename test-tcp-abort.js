const { AgentVM } = require("./src/index.js");

async function test() {
    const vm = new AgentVM({ network: true, debug: true });
    await vm.start();
    console.log("VM READY");
    
    // Test DNS first
    console.log("\n=== TEST 1: DNS before download ===");
    let r = await vm.exec("nslookup google.com 2>&1 | head -3");
    console.log(r.stdout);
    
    // Start a download and abort it by running a timeout curl
    console.log("\n=== TEST 2: Short download (should complete) ===");
    r = await vm.exec("curl -s -o /dev/null -w '%{http_code}' http://google.com");
    console.log("HTTP status:", r.stdout);
    
    // Start a larger download with a timeout that will abort it
    console.log("\n=== TEST 3: Download with timeout (will abort) ===");
    r = await vm.exec("timeout 3 curl -o /dev/null http://ipv4.download.thinkbroadband.com/10MB.zip 2>&1 || echo 'Download aborted as expected'");
    console.log(r.stdout);
    
    // Test DNS after abort
    console.log("\n=== TEST 4: DNS after aborted download ===");
    r = await vm.exec("nslookup google.com 2>&1 | head -3");
    console.log(r.stdout);
    
    // Try another download
    console.log("\n=== TEST 5: HTTP after aborted download ===");
    r = await vm.exec("curl -s -o /dev/null -w '%{http_code}' http://google.com");
    console.log("HTTP status:", r.stdout);
    
    console.log("\n=== ALL TESTS COMPLETE ===");
    process.exit(0);
}

test().catch(e => {
    console.error("ERROR:", e);
    process.exit(1);
});
