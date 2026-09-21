// virtio-snd playback: the guest plays a WAV with aplay and the host receives
// PCM via onAudio()/getAudioFormat().
const { AgentVM } = require('../src/index');

function withTimeout(promise, ms = 60000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

// 0.2 s of a 440 Hz sine, 48 kHz stereo S16_LE, written with Python's wave.
const GEN = `import wave, struct, math
sr = 48000
w = wave.open('/tmp/tone.wav', 'wb')
w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
fr = bytearray()
for i in range(sr // 5):
    v = int(16000 * math.sin(2 * math.pi * 440 * i / sr))
    fr += struct.pack('<hh', v, v)
w.writeframes(bytes(fr)); w.close()
print('frames', sr // 5)
`;

async function test() {
    const vm = new AgentVM();
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };
    try {
        await withTimeout(vm.start(), 60000);

        const card = await withTimeout(vm.exec('aplay -l 2>&1 | head -3; ls /dev/snd/'), 20000);
        check('virtio sound card present', /VirtIO SoundCard/.test(card.stdout), card.stdout.split('\n')[1] || '');
        check('/dev/snd nodes exist', /controlC0/.test(card.stdout) && /pcmC0D1p/.test(card.stdout), '');

        let chunks = 0, bytes = 0, fmt = null, sample = null;
        vm.onAudio((a) => { chunks++; bytes += a.data.length; fmt = a; if (!sample) sample = a.data; });

        await withTimeout(vm.exec(`cat > /tmp/gen.py <<'PYEOF'\n${GEN}PYEOF\npython3 /tmp/gen.py`), 60000);
        const t0 = Date.now();
        const r = await withTimeout(vm.exec('aplay -D plughw:0,1 /tmp/tone.wav 2>&1'), 90000);
        const ms = Date.now() - t0;

        check('aplay exits 0', r.exitCode === 0, JSON.stringify(r.stdout.trim().slice(0, 80)));
        check('host received PCM', chunks > 0 && bytes > 0, `chunks=${chunks} bytes=${bytes}`);
        check('format is 48 kHz stereo s16le', fmt && fmt.sampleRate === 48000 && fmt.channels === 2 && fmt.format === 's16le',
            fmt ? `${fmt.sampleRate}/${fmt.channels}/${fmt.format}` : 'none');
        const af = vm.getAudioFormat();
        check('getAudioFormat matches', af && af.sampleRate === 48000 && af.channels === 2, JSON.stringify(af));
        check('PCM is S16_LE (non-empty, even length)', bytes % 4 === 0 && sample && sample.length > 0, `bytes=${bytes}`);
        console.log(`      (aplay took ${ms} ms for ~200 ms of audio)`);

        // Regression: closing a stream releases it; the device must complete
        // pending TX on RELEASE or the next open times out ("failed to flush").
        const r2 = await withTimeout(vm.exec('aplay -D plughw:0,1 /tmp/tone.wav 2>&1'), 90000);
        check('aplay reopens after release (no wedge)', r2.exitCode === 0, JSON.stringify(r2.stdout.trim().slice(0, 80)));
        const dm = await withTimeout(vm.exec('dmesg 2>/dev/null | grep -c "failed to flush" || true'), 20000);
        check('no "failed to flush" in dmesg', dm.stdout.trim() === '0', dm.stdout.trim());
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll audio tests passed.' : `\n${failures} audio test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();
