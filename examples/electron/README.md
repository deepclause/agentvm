# AgentVM + Electron audio

Plays audio produced inside the guest (virtio-snd -> ALSA) on the host with Web
Audio.

```bash
cd examples/electron
npm install
# point at an image built with AUDIO=1 (the default):
AGENTVM_WASM=../../agentvm-alpine-python.wasm npm start
```

Then generate a WAV inside the VM (or use `/usr/bin/aplay` with any file) and
play it:

```
python3 - <<'PY'
import wave,struct,math
w=wave.open('/tmp/tone.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
w.writeframes(b''.join(struct.pack('<hh',int(16000*math.sin(2*math.pi*440*i/48000)),)*2 for i in range(48000)))
w.close()
PY
aplay -D plughw:0,1 /tmp/tone.wav
```

`main.js` subscribes to `vm.onAudio()` and forwards each S16_LE PCM buffer to the
renderer over IPC; `renderer.js` converts to Float32 and feeds an AudioWorklet
(`worklet.js`). The guest's card is `hw:0,1` (`aplay -l`).

Notes: the guest emits 48 kHz stereo S16_LE; the AudioWorklet assumes the host
`AudioContext` runs at 48000 Hz (set explicitly). Audio is emulated best-effort,
so expect jitter under heavy load.
