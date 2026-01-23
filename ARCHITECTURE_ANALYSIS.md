# AgentVM Architecture Analysis

## Overview

AgentVM is a lightweight Node.js library that runs a WebAssembly-based Alpine Linux virtual machine. It enables AI agents to execute shell commands in a sandboxed environment with full networking capabilities (TCP/UDP NAT with DHCP and DNS support) and optional host filesystem mounts.

## Core Components

### 1. Main Thread (`src/index.js`)

The `AgentVM` class runs on the Node.js main thread and manages:

- **Worker Thread Lifecycle**: Spawns and manages a dedicated Worker thread that runs the WASM VM
- **Command Execution Protocol**: Implements request-response pattern using sentinel markers to detect command completion
- **Network Socket Management**: Handles real TCP/UDP sockets via Node.js APIs (since Worker threads cannot directly use the async event loop for sockets)
- **MessageChannel Communication**: Uses `MessageChannel` to pass network data between main thread and worker

**Key Data Structures:**
- `sharedBuffer` (SharedArrayBuffer, 64KB): Used for stdin communication with Atomics-based synchronization
- `tcpSessions` (Map): Tracks active TCP connections on the host side
- `udpSessions` (Map): Tracks active UDP sessions on the host side
- `netChannel` (MessageChannel): Bidirectional communication for network events

**Network Message Types (Main Thread → Worker):**
- `tcp-connected`: TCP connection established
- `tcp-data`: Data received from remote server
- `tcp-end`: Remote sent FIN (connection closing)
- `tcp-close`: Connection fully closed
- `tcp-error`: Connection error
- `udp-recv`: UDP response received

**Network Message Types (Worker → Main Thread):**
- `tcp-connect`: Request to open TCP connection
- `tcp-send`: Send data over TCP
- `tcp-close`: Close TCP connection
- `tcp-pause` / `tcp-resume`: Flow control signals
- `udp-send`: Send UDP packet

### 2. Worker Thread (`src/worker.js`)

The Worker thread runs the WASM emulator in a blocking loop and handles:

- **WASI Implementation**: Custom WASI (WebAssembly System Interface) implementation with intercepted syscalls
- **Network Stack Integration**: Routes network I/O through the `NetworkStack` class
- **File Descriptor Management**: Custom handling for stdin (fd 0), stdout (fd 1), stderr (fd 2), network listen socket (fd 3), and network connection socket (fd 4)
- **Preopened Directories**: Supports host filesystem mounts with custom `path_open` implementation

**Key WASI Syscall Overrides:**
- `fd_read`: Handles stdin (blocking with Atomics.wait) and network socket reads
- `fd_write`: Handles stdout/stderr forwarding and network writes
- `poll_oneoff`: Critical for async I/O - polls stdin, network, and timers
- `sock_accept`: Accepts the single network "connection" (fd 3 → fd 4)
- `sock_recv` / `sock_send`: Network data transfer on fd 4

**Polling Architecture:**
The VM uses `poll_oneoff` extensively for async I/O. The Worker implementation:
1. Scans all subscriptions (stdin, network, timers)
2. Checks immediate readiness
3. If not ready, enters a short polling loop (5ms chunks) with `Atomics.wait`
4. Between waits, calls `netStack.pollNetResponses()` to check for network messages

### 3. Network Stack (`src/network.js`)

The `NetworkStack` class implements a userspace TCP/IP stack that:

- **Parses Ethernet Frames**: Processes QEMU-framed packets from the WASM emulator
- **Handles ARP**: Responds to ARP requests for the gateway
- **Implements DHCP Server**: Provides IP assignment to the VM (192.168.127.3/24)
- **Processes IP Packets**: Routes ICMP, TCP, and UDP traffic
- **Manages TCP State Machine**: Full connection lifecycle (SYN, ACK, data, FIN)
- **Handles UDP NAT**: Stateless forwarding via main thread sockets

**Network Topology:**
```
┌─────────────────────────────────────────────────────────────┐
│  WASM VM (Guest)                                            │
│  IP: 192.168.127.3                                          │
│  Gateway: 192.168.127.1                                     │
│  DNS: 8.8.8.8                                               │
└─────────────────┬───────────────────────────────────────────┘
                  │ QEMU-framed Ethernet (fd 3/4)
                  │
┌─────────────────▼───────────────────────────────────────────┐
│  NetworkStack (Worker Thread)                               │
│  - Parses Ethernet/IP/TCP/UDP                               │
│  - DHCP server                                              │
│  - TCP NAT state machine                                    │
│  - MessagePort communication with main thread               │
└─────────────────┬───────────────────────────────────────────┘
                  │ MessageChannel
                  │
┌─────────────────▼───────────────────────────────────────────┐
│  Main Thread Socket Handlers                                │
│  - Real TCP sockets (net.Socket)                            │
│  - Real UDP sockets (dgram)                                 │
│  - Routes to external network                               │
└─────────────────────────────────────────────────────────────┘
```

**TCP State Machine:**
```
         SYN from VM
              │
              ▼
     ┌─────────────┐       tcp-connect to main thread
     │  SYN_SENT   │ ─────────────────────────────────►
     └──────┬──────┘
            │ tcp-connected from main thread
            ▼
     ┌─────────────┐
     │ ESTABLISHED │ ◄────► Data transfer
     └──────┬──────┘
            │ FIN from remote (tcp-end)
            ▼
     ┌─────────────┐
     │  FIN_WAIT   │
     └──────┬──────┘
            │ FIN from VM
            ▼
     ┌─────────────┐
     │   CLOSED    │
     └─────────────┘
```

**Flow Control:**
- TX buffer high water mark: 16KB (triggers pause)
- TX buffer low water mark: 4KB (triggers resume)
- Main thread socket pause/resume based on worker buffer pressure

## Data Flow

### Command Execution Flow
```
1. Client calls vm.exec("ls -la")
2. Main thread generates UUID marker and writes command to SharedArrayBuffer
3. Worker thread wakes up from Atomics.wait, reads command from SharedArrayBuffer
4. WASM VM executes command via shell
5. stdout/stderr sent back via parentPort.postMessage
6. When marker detected in stdout, command completes
7. Promise resolves with {stdout, stderr, exitCode}
```

### Network Data Flow (HTTP Download)
```
1. VM's wget initiates DNS query (UDP to 8.8.8.8:53)
2. NetworkStack parses UDP, sends via MessagePort to main thread
3. Main thread creates UDP socket, sends query, receives response
4. Response sent back via MessagePort, NetworkStack builds response packet
5. VM resolves hostname, initiates TCP SYN to HTTP server
6. NetworkStack sends tcp-connect to main thread
7. Main thread creates TCP socket, connects
8. tcp-connected sent back, NetworkStack sends SYN-ACK to VM
9. HTTP request/response data flows through the NAT
10. Connection teardown via FIN exchange
```

## Key Design Decisions

### Why Worker Threads?
- WASM execution is blocking (single-threaded emulator loop)
- Worker thread allows main thread to remain responsive
- Enables async network I/O via main thread sockets

### Why SharedArrayBuffer for Stdin?
- Efficient data transfer without message passing overhead
- `Atomics.wait/notify` enables blocking read semantics needed by WASM
- Avoids complex stream piping

### Why MessageChannel for Network?
- Worker threads cannot use Node.js async APIs (net, dgram)
- Main thread must own sockets
- MessageChannel provides reliable bidirectional communication
- `receiveMessageOnPort` enables synchronous polling in worker

### Why Custom WASI Implementation?
- Node.js WASI has bugs with 64-bit rights validation
- Need custom handling for network socket file descriptors
- Preopened directory handling requires workarounds

## Identified Issues

### Issue: DNS Fails After TCP Connection Closes (FIXED)

**Symptom:** First HTTP download succeeds, subsequent downloads fail with "bad address"

**Root Cause Analysis:**
After investigating, the issue was found in TCP connection cleanup affecting the network stack state.

The `natTable` in NetworkStack stores TCP session state. When examining the code flow:

1. In `_handleTcpEnd` (when remote sends FIN):
   - Sets session state to `FIN_WAIT`
   - Sends FIN-ACK to VM
   
2. `sock_recv` checks `hasReceivedFin()` which returns true when any session is in `FIN_WAIT` or `CLOSED_BY_REMOTE` state

3. After first download, session stayed in `FIN_WAIT` state indefinitely because:
   - The VM application (wget) processed EOF and exited
   - But never explicitly closed the socket (fd 4)
   - Session was never cleaned up from `natTable`

4. On subsequent downloads, `hasReceivedFin()` returned `true` (for the stale session), causing `poll_oneoff` to report the socket as readable with EOF, preventing proper DNS resolution.

**The Fix:**
Two changes were made:

1. **In `sock_recv` (worker.js)**: When returning EOF due to FIN, also clean up the connection:
   ```javascript
   // Clean up the connection to allow new connections
   netStack.closeSocket();
   netConnectionAccepted = false;
   sockRecvBuffer = Buffer.alloc(0);
   ```

2. **In `closeSocket` (network.js)**: Actually delete sessions from `natTable` and clean up stale sessions:
   ```javascript
   // Delete the session to allow new connections
   this.natTable.delete(key);
   
   // Also clean up any stale closed sessions
   for (const [key, session] of this.natTable) {
       if (session.state === 'CLOSED_BY_REMOTE' || session.state === 'CLOSED' || session.state === 'FIN_SENT') {
           this.natTable.delete(key);
       }
   }
   ```

3. **In `fd_close(NET_CONN_FD)` (worker.js)**: Reset connection state:
   ```javascript
   netConnectionAccepted = false;
   sockRecvBuffer = Buffer.alloc(0);
   ```

## Files Summary

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.js` | 433 | Main AgentVM class, worker management, host-side sockets |
| `src/worker.js` | 1022 | WASI implementation, VM execution loop |
| `src/network.js` | 853 | Userspace TCP/IP stack, DHCP, NAT |

## Dependencies

- Node.js ≥20.0.0 (for WASI preview1 support)
- Built-in modules only: `worker_threads`, `wasi`, `dgram`, `net`, `fs`, `crypto`
- External WASM: `agentvm-alpine-python.wasm` (Alpine Linux emulator)
