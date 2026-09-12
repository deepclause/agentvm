'use strict';

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

async function main() {
    const instructions = [0x00012083, 0x00108093, 0x00112023]; // lw x1,0(x2); addi x1,x1,1; sw x1,0(x2)
    const module = new RiscVBlockJit(instructions, null, { externalMemory: true }).compile();

    let storedValue = null;
    const load = (statePtr, addr, size) => 42n;
    const store = (statePtr, addr, size, val) => { storedValue = val; return 0; };

    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = new WebAssembly.Instance(module, { env: { memory, load, store } });
    const regs = new BigInt64Array(memory.buffer, 0, 32);

    const nextPc = instance.exports.run(0, 256, 0n, 123);
    assert.strictEqual(regs[1], 43n, 'load + addi result');
    assert.strictEqual(storedValue, 43n, 'stored value');
    assert.strictEqual(nextPc, 12n, 'fall-through pc');
    console.log('JIT external memory test passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
