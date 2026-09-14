# AgentVM feature proposal: network control, firewall, port forwarding, persistent root fs

Status: proposal (not implemented).

Scope: `deepclause-agentvm` (the npm package, `../agentvm`) plus how `pi-box`
consumes it. All four features are runtime-friendly: none should require a VM
restart, and persistent settings are stored per workspace.

---

## Architecture context

The current network path is:

```
guest apps → guest kernel (virtio-net) → worker NetworkStack (src/network.js)
  → ring buffer (src/ringbuffer.js) → main thread NAT (src/index.js)
  → host TCP/UDP/DNS via Node
```

- The **main thread** sees every guest-initiated `tcp-connect`, `udp-send`, and
  `dns-lookup`, and owns all host sockets. This is the natural home for the
  network toggle, the firewall, and the host side of port forwarding.
- The **worker** already runs a full guest-facing TCP state machine
  (`src/network.js`), including handshake, retransmit, and flow control. Port
  forwarding reuses that state machine for the guest side of an inbound
  connection.
- The **ring buffer** carries main→worker messages (`TCP_CONNECTED`,
  `TCP_DATA`, `TCP_END`, `TCP_ERROR`, `TCP_CLOSE`, `UDP_RECV`, `DNS_RESULT`).
  Port forwarding adds one new message type.
- The guest NIC **cannot** be brought down from inside the guest
  (`ip link set eth0 down` → `EPERM`; ioctl is not emulated). Networking is
  therefore controlled host-side, not guest-side.

Filesystem path today:

```
guest /  = c2w image (read-only lower) + tmpfs writable layer (lost on stop)
/workspace = 9p mount → host workspace dir (persists)
```

Only the 9p mount persists. Everything else in the guest root is ephemeral.

---

## 1. Network on/off toggle (no reboot)

### Goal

Stop and start all guest networking at runtime, and expose it as a boolean that
the host app can show and toggle.

### Design

All changes are in `src/index.js` (`AgentVM`):

- Add `this.networkEnabled = options.network !== false`.
- Add `setNetworkEnabled(enabled)`:
  - update the flag
  - on `false`: destroy and clear every `tcpSessions`/`udpSessions` socket so
    live connections drop immediately
  - on `true`: no action; the guest keeps its DHCP lease and can open new flows
- Guard the three NAT entry points with the flag:
  - `_handleTcpConnect` → drop when disabled
  - `_handleUdpSend` → drop when disabled
  - `_handleDnsLookup` → drop when disabled

### Semantics and edge cases

- The guest still sees `eth0` as up, so "off" is a dead network, not a missing
  interface. New guest connections hang until the guest's own TCP timeout
  (~2 min) rather than failing instantly.
- Optional follow-up: add a worker flag so the worker answers new guest SYNs
  with `RST`, giving the guest an immediate `ECONNREFUSED`. Defer from v1.
- DNS lookups already in flight when disabling are ignored.
- Re-enabling does not require re-running DHCP (lease/address persist).

### API

```ts
agentvm.setNetworkEnabled(boolean): void
agentvm.networkEnabled: boolean
```

### App integration

`VmManager.toggleNetwork()` calls `vm.setNetworkEnabled(!vm.networkEnabled)`
(instead of the current guest `ip link` command) and broadcasts the state.

### Effort

Low (~40 lines in `src/index.js`).

---

## 2. Firewall rules (incoming and outgoing)

### Goal

Filter guest traffic with ordered, live-editable rules. Outbound = guest
initiated. Inbound only exists once port forwarding (#3) exists, because the
guest is otherwise unreachable.

### Design

- Ordered rule list, first match wins, default action `allow` (configurable).
- Rule shape:

  ```json
  {
    "id": "block-example-tls",
    "direction": "out",
    "protocol": "tcp",
    "remote": "*.example.com",   // hostname | IP | CIDR | "*"
    "port": "443",               // port | "8000-9000" | "*"
    "action": "deny"
  }
  ```

- `direction: "in"` applies to port-forwarded connections only.
- Hook points (main thread `src/index.js`):
  - `_handleTcpConnect` → match `out/tcp` on `dstIP:dstPort`
  - `_handleUdpSend` → match `out/udp`
  - `_handleDnsLookup` → match `out/udp:53`; optionally match by hostname
    (the name is already parsed before resolution, so name-based blocking is
    nearly free)
- Rule matching resolves hostnames using the same `dns.lookup` already used by
  the NAT, then compares the resolved IP against IP/CIDR rules.

### Non-goals / notes

- ICMP echo (guest `ping`) is answered inside `src/network.js` and never
  reaches the main thread, so ICMP is not filterable in v1 (document this).
- UDP is connectionless; "allow" vs "deny" applies per datagram.

### API

```ts
agentvm.setFirewall({ default: 'allow' | 'deny', rules: FirewallRule[] }): void
agentvm.clearFirewall(): void
```

Rules apply immediately and are validated on input (CIDR/port range parsing).

### Persistence

- Per-workspace file `.pi-box/firewall.json`, loaded by the app and pushed via
  `setFirewall` after each VM start.
- A host-app default can live in app userData for workspaces without a file.

### Effort

Medium (~150–250 lines: rule matcher, validation, hooks).

---

## 3. Port forwarding (runtime add/remove, no restart)

### Goal

Expose servers running inside the guest on host ports, and allow adding and
removing forwards at any time without restarting the VM.

### Design

A forward is:

```json
{ "hostPort": 3000, "guestPort": 3000, "guestHost": "192.168.127.2", "protocol": "tcp" }
```

**Host side (main thread, `src/index.js`)**

- `addPortForward(...)` starts a `net.Server` on `127.0.0.1:hostPort`
  (loopback by default; opt-in bind to `0.0.0.0` for LAN exposure).
- On accept:
  1. allocate a flow `key`
  2. register the accepted host socket in the existing `tcpSessions` map
     (reuses all the current key-based piping)
  3. write a new ring-buffer message `TCP_INCOMING_CONNECT { key, dstPort, srcPort }`
     to the worker.
- `removePortForward(...)` closes the listener and tears down its flows.
- Forwards are live: adding/removing binds/unbinds the host listener
  immediately. They may also be registered before `start()`; listeners bind
  once the VM is running.

**Guest side (worker, `src/network.js` + `src/ringbuffer.js`)**

- Add `NET_MSG_TCP_INCOMING_CONNECT` to the ring buffer (main→worker), with a
  writer in `src/ringbuffer.js`.
- In `NetworkStack.pollNetResponses()`, handle the new message by creating a
  guest-facing TCP flow via an **active open**:
  - craft a SYN from the gateway `192.168.127.1` to `guestHost:guestPort`
    (source port = an allocated ephemeral port)
  - insert a flow in a new `SYN_SENT` (guest-side) state
  - when the guest replies SYN-ACK, transition to established and reuse the
    existing `_maybeSend` / `_acknowledge` / `_retransmit` / flow-control logic.
- After establishment, data, backpressure, and teardown are identical to an
  outbound flow: host socket ⇄ key ⇄ worker flow ⇄ guest. Only the initiation
  direction differs.

### Why this is clean

The outbound path is already "guest SYN → worker flow → host socket → key-based
pipe". Port forwarding is the mirror image: "host accept → key → worker active
open → same pipe". The `tcpSessions` map, key convention, and most ring messages
are reused unchanged.

### Edge cases

- Guest server not listening yet → worker gets RST/refused; propagate back to
  the host socket and destroy the flow.
- Forward removed while connections are active → close listener, RST live flows.
- `hostPort` already bound → return an error to the caller.
- UDP forwarding: defer; TCP-only in v1 (UDP needs a host-side UDP socket ↔
  guest UDP flow mapping, which is a smaller but separate piece).

### API

```ts
agentvm.addPortForward({ hostPort, guestPort, guestHost?, protocol? }): Promise<void> | void
agentvm.removePortForward(hostPort): void
agentvm.listPortForwards(): PortForward[]
```

### App integration

- A "Ports" section in the sidebar: list forwards, add/remove at runtime.
- Persist per-workspace in `.pi-box/ports.json`; re-apply on start (but the API
  itself is live and never requires a restart).

### Effort

Medium-high (~300–500 lines across `ringbuffer.js`, `network.js`, `index.js`):
one new message type + writer, one active-open TCP method in the worker, and a
listener lifecycle in main.

---

## 4. Persistent root filesystem (overlay, per workspace)

### Goal

Persist the **whole guest root filesystem** across VM restarts, per workspace:
`apk add` packages, `/etc`, `/root`, `/tmp`, pi's global caches, etc. Switching
workspaces switches the entire machine state.

### Chosen approach: true overlay (Tier 3)

The guest root becomes a Linux overlay:

```
guest /  =  overlay
            ├── lowerdir = read-only image root (the c2w image)
            └── upperdir = 9p-backed dir in the workspace: <ws>/.pi-box/overlay/upper
                workdir  = <ws>/.pi-box/overlay/work
```

All writes land in `upperdir`, which is a 9p mount and therefore persists on the
host. Reads hit the image unless a write has shadowed them.

### Components

1. **Persistent storage**
   - `upper`/`work` directories live under the existing 9p mount at
     `/workspace/.pi-box/overlay/`, so they are automatically per-workspace.
   - The host app creates them on first launch (alongside `.pi-box/config`).

2. **Mount + pivot, integrated into the startup script**
   - Prepend to the injected startup script (before tmux/pi):
     ```sh
     mkdir -p /workspace/.pi-box/overlay/upper /workspace/.pi-box/overlay/work
     mount -t overlay overlay \
       -o lowerdir=/,upperdir=/workspace/.pi-box/overlay/upper,workdir=/workspace/.pi-box/overlay/work \
       /newroot
     # keep the workspace visible inside the new root, then switch
     mkdir -p /newroot/workspace
     mount --move /workspace /newroot/workspace   # if --move unsupported: bind mount
     pivot_root /newroot /newroot/.oldroot  (or chroot /newroot) + exec /bin/sh
     ```
   - The app's `VmManager.start()` already injects a startup script after the
     shell prompt; this overlay preamble slots in before the `cd`/tmux lines.
   - Benefit: no image/init rebuild is required to iterate; the overlay logic
     is part of the app-controlled boot script.

3. **Console/9p preservation**
   - `/dev/console` and `/workspace` must remain reachable after the switch.
   - The `tty-resize-daemon.py` and `.pi` files are on `/workspace`, so they
     are unaffected once `/workspace` is re-attached inside the new root.

### Open items to verify before committing to this approach

1. **Kernel overlayfs support** — critical. The emulated RISC-V kernel inside
   the c2w image may or may not have `CONFIG_OVERLAY_FS`. Verify at build time;
   if missing, enable it in the image's kernel config (image rebuild), or fall
   back to Tier 1 (tar snapshot) temporarily.
2. **`mount --move` / `pivot_root` availability** in busybox. If `pivot_root`
   is problematic, use `chroot /newroot` + `exec /bin/sh`, accepting slightly
   messier process semantics.
3. **Overlay upper on 9p** — correctness and performance. 9p supports the
   needed basic ops (open/read/write/mkdir/unlink/rename), but this needs a
   soak test (e.g. `apk add`, `npm install -g`, pi cache writes) before
   declaring it stable. There is also no `chmod` on the mount (existing known
   limitation), which overlay may hit when creating upper entries.
4. **First boot vs later boots** — first boot has no upper dir; the overlay is
   simply empty, and the image is the effective root. No special casing beyond
   `mkdir -p`.

### Data model

```
<workspace>/.pi-box/
├── config            # startup script (existing)
├── firewall.json     # feature 2
├── ports.json        # feature 3
└── overlay/
    ├── upper/        # overlay upperdir (feature 4)
    └── work/         # overlay workdir
```

Everything under `.pi-box` is per-workspace and persists. The workspace 9p
mount is the single source of truth; no new agentvm mount types are needed.

### Fallback

If overlayfs cannot be made available, use the Tier 1 snapshot as an interim:
on stop, `tar czf /workspace/.pi-box/root.tar.gz / --exclude=/workspace
--exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run`; on start,
extract. Slower, but no kernel changes.

### Effort

Medium (mostly guest-side startup-script logic + validation), with a build-time
dependency on kernel overlayfs support. The risky part is verification, not
lines of code.

---

## Suggested sequencing

1. **Network toggle** — small, unblocks the app's network button.
2. **Firewall** — builds directly on the toggle's hooks.
3. **Port forwarding** — larger; depends on the ring/worker plumbing.
4. **Overlay fs** — independent; start with the overlayfs/9p verification
   spike, then the startup-script integration.

Items 1–3 are `agentvm`-only and consumed by `pi-box` via new methods. Item 4
is mostly `pi-box` startup-script logic plus a possible image/kernel rebuild.
