const { AgentVM } = require('../../src/index');
const assert = require('assert');

function withTimeout(promise, ms = 60000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

async function test() {
    console.log("Initializing AgentVM with Network...");
    const vm = new AgentVM();
    
    try {
        await withTimeout(vm.start());
        console.log("VM Started.");

        // Check network interface
        let res = await withTimeout(vm.exec("ip link show"));
        console.log("Network Interfaces:", JSON.stringify(res.stdout));
        
        // First, bring the interface up - this is required before DHCP
        console.log("Bringing up eth0...");
        res = await withTimeout(vm.exec("ip link set eth0 up"));
        console.log("ip link set eth0 up result:", res.exitCode);
        
        // Check if interface is up
        res = await withTimeout(vm.exec("ip link show eth0"));
        console.log("eth0 after up:", JSON.stringify(res.stdout));
        
        // Try DHCP client (Alpine uses udhcpc from busybox)
        console.log("Running DHCP client...");
        res = await withTimeout(vm.exec("udhcpc -i eth0 -n -q -t 5 2>&1 || echo 'DHCP failed'"), 30000);
        console.log("DHCP Result:", JSON.stringify(res.stdout));
        
        // Check IP and routes after DHCP
        console.log("Checking IP and Routes after DHCP...");
        const ipRes = await withTimeout(vm.exec("ip addr show eth0"));
        console.log("eth0 IP:", JSON.stringify(ipRes.stdout));
        const routeRes = await withTimeout(vm.exec("ip route"));
        console.log("Routes:", JSON.stringify(routeRes.stdout));
        
        // If DHCP didn't work, try static IP
        if (!ipRes.stdout.includes('192.168.127.3')) {
            console.log("DHCP did not assign IP, trying static configuration...");
            await withTimeout(vm.exec("ip addr add 192.168.127.3/24 dev eth0 2>/dev/null || true"));
            await withTimeout(vm.exec("ip route add default via 192.168.127.1 2>/dev/null || true"));
            
            const ipRes2 = await withTimeout(vm.exec("ip addr show eth0"));
            console.log("eth0 IP (static):", JSON.stringify(ipRes2.stdout));
            const routeRes2 = await withTimeout(vm.exec("ip route"));
            console.log("Routes (static):", JSON.stringify(routeRes2.stdout));
        }
        
        // Try to ping the gateway
        console.log("Pinging Gateway...");
        res = await withTimeout(vm.exec("ping -c 1 -W 5 192.168.127.1"));
        console.log("Ping Result:", JSON.stringify(res));
        
        if (res.exitCode === 0) {
            console.log("SUCCESS: Network is working!");
        } else {
            console.log("Ping failed, dumping debug info...");
            res = await withTimeout(vm.exec("cat /proc/net/dev"));
            console.log("/proc/net/dev:", JSON.stringify(res.stdout));
            res = await withTimeout(vm.exec("dmesg | grep -i eth"));
            console.log("dmesg eth:", JSON.stringify(res.stdout));
        }

    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        await vm.stop();
    }
}

test();
