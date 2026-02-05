# AgentVM Skill for OpenClaw

This directory contains an OpenClaw Skill that integrates `deepclause-agentvm`, allowing your AI assistant to execute shell commands and scripts in a secure, sandboxed Alpine Linux environment.

## Integration Steps

To use this skill in your OpenClaw installation, follow these steps:

### 1. Install Dependencies

You need to add the `deepclause-agentvm` package to your OpenClaw project.

```bash
# In your openclaw root directory
npm install deepclause-agentvm
# or
pnpm add deepclause-agentvm
```

### 2. Install the Skill

Copy the `skill` directory from here into your OpenClaw skills folder.

**Option A: Global/Workspace Skills** (Recommended)
Copy to your workspace skills directory (usually `~/.openclaw/workspace/skills/`):

```bash
mkdir -p ~/.openclaw/workspace/skills/agentvm
cp -r example/openclaw/* ~/.openclaw/workspace/skills/agentvm/
```

**Option B: Source Integration**
If you are modifying the OpenClaw source code directly:

```bash
cp -r example/openclaw openclaw/skills/agentvm
```

### 3. Restart OpenClaw

Restart your OpenClaw gateway or process to load the new skill.

```bash
openclaw gateway restart
```

## Usage

Once installed, the agent will automatically have access to the `linux_sandbox_exec` tool. You can simply ask it to run commands.

**Example Prompts:**

> "List the files in the current directory using the Linux sandbox."

> "Calculate the first 10 Fibonacci numbers using Python in the VM."

> "Check if the VM has internet access by pinging google.com."

## Files

- `skill/SKILL.md`: The skill definition and prompt instructions.
- `skill/index.ts`: The TypeScript implementation of the tool.
- `example.ts`: A standalone script to verify the skill works in isolation before integrating.
