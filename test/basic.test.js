const { AgentVM } = require('../src/index');

function withTimeout(promise, ms = 5000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
    ]);
}

async function test() {
    console.log("Initializing AgentVM...");
    const vm = new AgentVM();
    
    try {
        await withTimeout(vm.start(), 5000);
        console.log("VM Started.");

        console.log("Running 'echo hello'...");
        let res = await withTimeout(vm.exec("echo hello"), 5000);
        console.log("Result:", JSON.stringify(res));
        if (res.stdout.trim() !== "hello") throw new Error("Output mismatch");

        console.log("Running Python math...");
        res = await withTimeout(vm.exec("python3 -c 'print(100 + 200)'"), 10000);
        console.log("Result:", JSON.stringify(res));
        if (res.stdout.trim() !== "300") throw new Error("Python Output mismatch");
        
        console.log("Running command with exit code...");
        res = await withTimeout(vm.exec("ls /nonexistent"), 5000);
        console.log("Result:", JSON.stringify(res));
        if (res.exitCode === 0) throw new Error("Should have failed");
        
        console.log("Running persistence test...");
        await withTimeout(vm.exec("export MYVAR=foobar"), 5000);
        res = await withTimeout(vm.exec("echo $MYVAR"), 5000);
        console.log("Result:", JSON.stringify(res));
        if (res.stdout.trim() !== "foobar") throw new Error("Persistence failed");

    } catch (e) {
        console.error("TEST FAILED:", e);
        process.exit(1);
    } finally {
        await vm.stop();
        console.log("VM Stopped.");
    }
}

test();