---
name: agentvm
description: Execute shell commands in a secure AgentVM sandbox (Alpine Linux).
---

# AgentVM Sandbox

This skill provides access to a secure, sandboxed Alpine Linux environment via AgentVM.
You can use this environment to:
- Execute shell commands (`ls`, `grep`, `curl`, etc.)
- Run Python scripts (`python3`)
- Perform calculations or data processing in isolation

## Tools

### `linux_sandbox_exec`

Executes a shell command in the VM and returns the output (stdout/stderr).

**Parameters:**
- `command` (string, required): The shell command to execute.

**Usage:**

```javascript
// List files
linux_sandbox_exec({ command: "ls -la /" });

// Run Python
linux_sandbox_exec({ command: "python3 -c 'print(1 + 1)'" });
```
