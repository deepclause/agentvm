import { AgentVM } from 'deepclause-agentvm';
import { tool } from 'ai';
import { z } from 'zod';

// Global instance to persist the VM across tool calls
let vmInstance: AgentVM | null = null;

async function getVM() {
  if (!vmInstance) {
    console.log('[AgentVM Skill] Initializing VM...');
    vmInstance = new AgentVM({
        // Optional: mount host directories or enable networking here
        network: true
    });
    await vmInstance.start();
    console.log('[AgentVM Skill] VM Ready.');
  }
  return vmInstance;
}

export const tools = {
  linux_sandbox_exec: tool({
    description: 'Execute a command in the sandboxed Alpine Linux VM.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute in the VM'),
    }),
    execute: async ({ command }) => {
      try {
        const vm = await getVM();
        console.log(`[AgentVM Skill] Executing: ${command}`);
        const result = await vm.exec(command);
        
        let output = result.stdout;
        if (result.stderr) {
            output += `\n[Stderr]: ${result.stderr}`;
        }
        if (result.exitCode !== 0) {
            output += `\n[Exit Code]: ${result.exitCode}`;
        }
        return output;
      } catch (error) {
        return `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  }),
};
