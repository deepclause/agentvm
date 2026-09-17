# Virtual framebuffer for AgentVM

Goal: expose a virtual framebuffer so that

1. code *inside* the guest can render to it (games, GUI apps, custom drawing),
2. an app *embedding* AgentVM can display it, and
3. input can flow back (keyboard/mouse).

Status: design. Nothing implemented yet.

## What we already have

TinyEMU is much closer than it looks:

- **`simplefb` is already compiled into the WASI build.** The c2w object list
  includes `simplefb.o` (`Dockerfile:306`). `simplefb_init` registers a linear
  framebuffer in guest physical RAM at `FRAMEBUFFER_BASE_ADDR` (`0x41000000`)
  and `riscv_machine.c:719` emits a `simple-framebuffer` FDT node
  (`reg`, `width`, `height`, `stride`, `format = "a8r8g8b8"`).
- **Damage tracking is already implemented.** `simplefb_init` registers the
  region with `DEVRAM_FLAG_DIRTY_BITS`, and `simplefb_refresh`
  (`simplefb.c`) walks the dirty bitmap and calls a `redraw_func(x, y, w, h)`
  for each damaged Y range. `fb_data` is a plain pointer into the WASM linear
  memory the host already owns, so reading pixels host-side is zero-copy.
- **Input exists.** `input_device: "virtio"` creates a virtio-input keyboard
  and tablet (`riscv_machine.c:967`), driven by
  `virtio_input_send_key_event` / mouse.
- What is missing is only the **driver**: SDL is disabled (`CONFIG_SDL=`,
  `sdl.o` not built), so nothing ever calls `fb_dev->refresh`, and no host
  wiring exists.

## Recommended design: native simple-framebuffer + host API

### Guest side
- Kernel: `CONFIG_FB_SIMPLE=y` (legacy `simplefb`) and `CONFIG_INPUT_EVDEV=y`
  (`CONFIG_FB=y` and `CONFIG_VIRTIO_INPUT=y` are already set; `FB_SIMPLE` is
  currently off). That yields `/dev/fb0` and `/dev/input/eventN`.
  (`CONFIG_DRM_SIMPLEDRM=y` + `DRM_FBDEV_EMULATION` is the modern equivalent if
  we ever want DRM; `simpledrm` supersedes `simplefb` when both are on.)
- TinyEMU config gets `display: "simplefb"`, `width`, `height`,
  `input_device: "virtio"`. AgentVM's `build.sh` already rewrites this config
  (it appends `drive1`), so it can inject these too, behind build args.
- Rendering paths inside the guest: direct `mmap("/dev/fb0")`, SDL2 with the
  `fbdev`/`kmsdrm` backend, X with `fbdev`, or any framebuffer library. Even
  Python can `mmap` `/dev/fb0`. Format is `a8r8g8b8`, `stride = width*4`.

### Host side
- TinyEMU patch: from the main loop (where `sdl_refresh` would run,
  `temu.c:950`), call `fb_dev->refresh(fb_dev, host_draw, NULL)`. `host_draw`
  is a WASI import, so the Node host handles each damaged rectangle by copying
  `fb_data + y*stride` for `w*4` bytes and forwarding it.
- Exports for the host: `fb_info()` (or `fb_ptr/width/height/stride`) and
  `input_key(...)` / `input_mouse(...)` that call the virtio-input devices.
- Worker: on `host_draw`, post `{x, y, width, height, stride, data}` to the
  main thread (transferable `ArrayBuffer`). Only damaged rects are sent, so a
  mostly-static frame costs almost nothing.
- AgentVM API:
  ```js
  const vm = new AgentVM({ framebuffer: { width: 1024, height: 768 } });
  await vm.start();
  vm.onFramebuffer(({ x, y, width, height, stride, data }) => blit(data));
  vm.getFramebuffer();              // full { width, height, data } snapshot
  vm.sendKey('ArrowLeft', true);    // or raw evdev codes
  vm.sendMouse(x, y, buttons);
  ```

### Input delivery
The worker is blocked inside `wasi.start`, so input can only be injected at a
WASI import boundary. Reuse the pattern already used for stdin: the main thread
writes events into a shared ring and `Atomics.notify`s; the worker drains it in
its `poll_oneoff`/`fd_read` import and calls the `input_*` exports. No new
synchronisation primitive needed.

### Pacing
Calling `fb_dev->refresh` from the main loop (every `MAX_SLEEP_TIME` = 10 ms)
is simple and bounded: it only scans the dirty bitmap and emits damaged rects.
If that is too chatty, add a paravirtual `PV_FB_FLUSH` hypercall (the custom-0
PV mechanism already exists for bulk memory) so the guest signals "frame
ready" and the host only reads when asked.

## Alternatives

| approach | guest cost | host work | input | effort | notes |
|---|---|---|---|---|---|
| **simplefb + host API** | none extra | TinyEMU patch + API | virtio-input | medium | zero-copy, damage-tracked, most native |
| **VNC** | X/Wayland + encoder under emulation | none (use `addPortForward`) | free | low | fastest to demo; low FPS; heavy guest stack |
| **virtio-gpu** | none | device + renderer | virtio-input | very high | 2D commands/resources/cursor; overkill |

AgentVM already has inbound port forwarding (`addPortForward` in
`src/index.js`), so the VNC path is a day's work if we want a demo now: run
`Xvfb`/`x11vnc` (or `wayvnc`) in the guest and forward 5900 to the embedding
app. The native path is the one worth owning long-term.

## Milestones

- **M0** — enable `simplefb` + `CONFIG_FB_SIMPLE`; confirm `/dev/fb0` and that
  writing pixels from the guest is visible in `fb_data`. Add `vm.getFramebuffer()`
  by copying the whole region on demand (no damage yet).
- **M1** — wire `host_draw` + `onFramebuffer` damaged-rect events.
- **M2** — input: virtio-input + the stdin-style ring + `sendKey`/`sendMouse`.
- **M3** — optional `PV_FB_FLUSH` to drop polling; shared-memory ring if frame
  copying ever matters.

## Things to decide

- Resolution and pixel format (fixed per image? configurable at `start()`?).
  A fixed 1024x768x32 costs 3 MB of guest RAM and rides in the Wizer snapshot.
- Is the framebuffer per-VM or per-session? It should be per-VM, like the rest
  of the machine state.
- Multi-display / scaling for HiDPI embeddings.
- Whether to also expose a Wayland/X socket so unmodified GUI apps work, or
  leave that to the VNC route.
