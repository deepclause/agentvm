---
name: agentvm
description: Execute shell commands in a secure AgentVM sandbox (Alpine Linux). Use when the user needs an isolated Linux environment, wants to run untrusted code safely, test shell commands, run Python scripts, or perform sandboxed data processing.
---

# AgentVM Sandbox

This skill provides access to a secure, sandboxed Alpine Linux environment via AgentVM.

## Use when

- The user needs to run shell commands in an isolated environment
- Executing untrusted or experimental code safely
- Running Python scripts without affecting the host system
- Performing sandboxed data processing or calculations

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

## Critical Rules

1. Each command runs in isolation — state does not persist between calls unless using the same session.
2. The sandbox runs Alpine Linux — use `apk` for package management.
3. Network access may be restricted depending on configuration.
