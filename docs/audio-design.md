# Virtual audio for AgentVM

Goal: code inside the guest (games, music, notifications) can play sound, and an
app embedding AgentVM can hear it (and optionally feed a microphone in).

Status: **implemented** (virtio-snd playback, `onAudio`/`getAudioFormat`, ALSA in
the guest, Electron example). Capture (RX/mic) is not implemented.

## Implemented

- `image/patches/tinyemu-virtio-snd.patch` adds a virtio-snd device (id 25, one
  playback stream, S16_LE 48 kHz stereo). It answers the control queue
  (`PCM_INFO`/`SET_PARAMS`/`PREPARE`/`START`/`STOP`/`RELEASE`), copies TX frames
  to the host via the `host_audio_write` import, and **paces TX-message
  completion** at the real period rate (the Linux driver immediately re-submits
  each completed message, so completing too early floods the host).
- **`RELEASE` completes all pending I/O messages.** The spec requires it and the
  Linux driver's `virtsnd_pcm_sync_stop` waits (`msg_timeout_ms`, default 1000)
  for `msg_empty`. Without it the stream wedges: `failed to flush I/O queue`, then
  every later `snd_pcm_open` returns `-ETIMEDOUT` until reboot (the driver calls
  `sync_stop` from `virtsnd_pcm_open` too). `STOP` keeps pending messages
  (pause/resume); only `RELEASE` flushes.
- `image/build.sh` (`AUDIO=1`, default) enables `SOUND`/`SND`/`SND_VIRTIO` and
  emits `audio_device: "virtio"`; the image gains `alsa-utils`/`alsa-lib`.
- `src/index.js` creates `/dev/snd/*` from `/sys/class/sound/*/dev` at boot and
  exposes `onAudio(cb)` / `getAudioFormat()`.
- `src/worker.js` handles `host_audio_write` and posts
  `{ sampleRate, channels, format:'s16le', data }`.
- `test/audio.test.js` and `examples/electron/` (Web Audio playback).

```js
vm.onAudio(({ sampleRate, channels, data }) => { /* S16_LE interleaved */ });
```

Guest: `aplay -l` shows `card 0: VirtIO SoundCard, device 1`; play with
`aplay -D plughw:0,1 file.wav`.

## Original design notes

Goal: code inside the guest (games, music, notifications) can play sound, and an
app embedding AgentVM can hear it (and optionally feed a microphone in).

## Options

| approach | guest support | host work | TinyEMU work | latency | notes |
|---|---|---|---|---|---|
| **virtio-snd** (device 25) | full ALSA (`/dev/snd/pcmC0D0p`) | `onAudio` + app playback | ~500-900 lines (4 vqs) | best | the "right" way, mirrors simplefb |
| **snd-aloop + guest daemon** | ALSA loopback card + daemon | `onAudio` + a transport | none | ok | needs `SND_ALOOP`, ALSA, a daemon, and a host transport |
| **snd-dummy + PulseAudio** | ALSA dummy + Pulse | pulse sink + module | none | poor | heavy guest stack |
| **app-level PCM stream** | only custom apps | `onAudio` | none | good | no ALSA; games won't use it |

### Recommended: virtio-snd

It is the exact analogue of the framebuffer work and gives real ALSA support,
so `aplay`, SDL2 (`SDL_AUDIODRIVER=alsa`), and any ALSA app work unchanged.

Kernel 6.1 already has the driver (`sound/virtio/`, `CONFIG_SND_VIRTIO`), so
the work is entirely on the emulator + host.

**Device shape** (`include/uapi/linux/virtio_snd.h`, device id `25`):

- Virtqueues: `CONTROL(0)`, `EVENT(1)`, `TX(2)`, `RX(3)`.
- Control requests: `JACK_INFO`, `JACK_REMAP`, `PCM_INFO`, `PCM_SET_PARAMS`,
  `PCM_PREPARE`, `PCM_RELEASE`, `PCM_START`, `PCM_STOP`, `CHMAP_INFO`, each with
  a small request/response struct and a status word (`VIRTIO_SND_S_OK = 0x8000`).
- Playback frames arrive on the **TX** queue as `virtio_snd_pcm_xfer`
  (stream_id) + PCM frames; capture uses the **RX** queue.
- Timing/notifications go out on the **EVENT** queue
  (`EVT_PCM_PERIOD_ELAPSED`, `EVT_PCM_XRUN`).

**MVP**: advertise one output PCM stream (2ch, S16_LE, 48000 Hz) plus one input
stream, answer the control messages, and forward TX frames to the host with a
`host_audio_write(sample_rate, channels, frames_ptr, bytes)` WASI import (the
same import/callback pattern as `host_fb_draw`). Emit `PERIOD_ELAPSED` events
from a timer so ALSA's period accounting advances.

**Phasing**

- **A.** Host API + a synthetic PCM source (no guest): validate `onAudio` and
  app playback.
- **B.** virtio-snd **playback** end-to-end: kernel `CONFIG_SOUND`/`SND`/
  `SND_VIRTIO`, device control + TX, `speaker-test`/`aplay` audible from the
  embedding app.
- **C.** Capture (RX) for a microphone, and format negotiation beyond the fixed
  stream.

## Host API sketch

```js
const vm = new AgentVM();
await vm.start();
vm.onAudio(({ sampleRate, channels, format, data }) => {
    // data is S16_LE interleaved PCM; enqueue on a Web Audio AudioWorklet
    audioCtx.enqueue(data, { sampleRate, channels });
});
const fmt = vm.getAudioFormat();      // { sampleRate, channels, format } once negotiated
```

Node itself has no audio output, so playback belongs to the embedding app
(Web Audio / Electron / native). For headless use, `onAudio` can be recorded to
a WAV, and a future `vm.sendAudio(pcm)` would feed the RX queue.

## Emulation realities (the hard part)

Audio is timing-sensitive and the emulator does not run at real time:

- The guest's ALSA clock is driven by `PERIOD_ELAPSED` events; if the device
  emits them on host wall time while the guest renders slower, the guest sees
  **xruns**. The device should pace events from the guest's own progress (or a
  large buffer), not a hard real-time clock.
- The host can play out at a fixed rate only if it buffers well ahead;
  otherwise audio is choppy under load. Expect a best-effort stream with a
  sizeable buffer (`AGENTVM_AUDIO_BUFFER_MS`) rather than low-latency audio.
- Format: keep one negotiated stream (48 kHz, stereo, S16_LE) to avoid
  resampling; resample on the host only if an app insists on another rate.

## Where sound and frames meet

A game that renders video and audio wants both clocks coherent. The framebuffer
already yields the emulator to the host every `MAX_EXEC_CYCLE`; the audio
device's period events should reuse that cadence so A/V stay roughly aligned.

## Next step

Implement Phase A (host API + synthetic PCM) to settle the app-side playback,
then the virtio-snd playback MVP (Phase B). The kernel is a small config change;
the image gains `alsa-lib`/`alsa-utils`.
