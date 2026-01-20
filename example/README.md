# AgentVM Examples

This directory contains examples demonstrating how to use **AgentVM** as a secure, sandboxed execution environment for AI agents.

The examples show how an LLM (via OpenAI) can be given a tool (`execute_shell_command`) to run code, manage files, or perform calculations inside an isolated Alpine Linux VM.

## Prerequisites

1.  **Node.js**: Required for the VM runtime (versions 20+ recommended).
2.  **OpenAI API Key**: Required for the actual AI interaction.
    *   *Note: If no API key is provided, the examples will run in a "Simulation Mode" with mock interactions.*
3.  **Python 3**: Required for the Python example.

## Setup

1.  **Install Node.js dependencies:**
    From the project root:
    ```bash
    npm install
    ```

2.  **Configure Environment:**
    Create a `.env` file in the `example/` directory (or root) with your API key:
    ```bash
    OPENAI_API_KEY=sk-...
    ```

## JavaScript Example

The `vercel-agent.js` file demonstrates how to integrate AgentVM directly with the [Vercel AI SDK](https://sdk.vercel.ai/).

**How it works:**
*   Instantiates `AgentVM` directly in Node.js.
*   Exposes a `execute_shell_command` tool to the LLM.
*   The LLM decides when to run shell commands to solve the user's prompt.

**Run:**
```bash
# From the project root
node example/vercel-agent.js
```

*Note: If you encounter module resolution errors, ensure you are running from the root or that the package is properly linked.*

## Python Example

The `vercel_agent.py` file demonstrates how to use AgentVM from Python using a bridge process.

**How it works:**
*   Python spawns a Node.js subprocess (`agent_bridge.js`).
*   Commands are sent via stdin/stdout using a lightweight JSON-RPC protocol.
*   The Python `AgentVMClient` class abstracts this communication, providing a clean API similar to the JS version.

**Setup Python dependencies:**
```bash
pip install -r example/requirements.txt
```

**Run:**
```bash
# From the project root
python3 example/vercel_agent.py
```
