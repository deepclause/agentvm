const logEl = document.getElementById('log');
const cmdEl = document.getElementById('cmd');
const log = (s) => { logEl.textContent += s + '\n'; logEl.scrollTop = logEl.scrollHeight; };

let ctx = null;
let node = null;

async function initAudio() {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [2] });
    node.connect(ctx.destination);
    log('audio ready: ' + ctx.sampleRate + ' Hz');
}

window.agentvm.onAudio(({ sampleRate, channels, data }) => {
    if (!node) return;
    if (ctx.state === 'suspended') ctx.resume();
    const n = data.length >> 1;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
    node.port.postMessage({ samples: f, channels }, [f.buffer]);
});

document.getElementById('run').addEventListener('click', async () => {
    const command = cmdEl.value;
    log('$ ' + command);
    const r = await window.agentvm.exec(command);
    log((r.stdout || '') + (r.stderr ? '[stderr] ' + r.stderr : ''));
});

initAudio().catch((e) => log('audio init failed: ' + e.message));
log('AgentVM starting... (wait for the VM, then run e.g. aplay /tmp/tone.wav)');
