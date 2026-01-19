const { AgentVM } = require('deepclause-agentvm');
const { generateText, tool } = require('ai');
const { openai } = require('@ai-sdk/openai'); // Hypothetical usage
const dotenv = require('dotenv');

dotenv.config();

// This example demonstrates how to define AgentVM as a tool for Vercel AI SDK.
// Note: You need an OPENAI_API_KEY in .env to run this effectively.

async function runAgent() {
    const vm = new AgentVM({});
    console.log("Booting VM...");
    await vm.start();
    console.log("VM Ready.");

    try {
        const tools = {
            execute_shell_command: tool({
                description: 'Execute a shell command in a sandboxed Linux environment. Use this to run Python scripts, check files, or perform calculations.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { 
                            type: 'string', 
                            description: 'The shell command to execute (e.g., "ls -la", "python3 -c ...")' 
                        },
                    },
                    required: ['command'],
                },
                execute: async ({ command }) => {
                    console.log(`[Tool] Executing: ${command}`);
                    const res = await vm.exec(command);
                    if (res.exitCode !== 0) {
                        return `Error (Exit ${res.exitCode}): ${res.stderr || res.stdout}`;
                    }
                    return res.stdout;
                },
            }),
        };

        // Example interaction (mocked if no API key)
        if (process.env.OPENAI_API_KEY) {
            const result = await generateText({
                model: openai('gpt-4-turbo'),
                tools: tools,
                maxSteps: 5,
                prompt: 'Calculate the 10th Fibonacci number using Python and tell me the result.',
            });

            console.log("\nAgent Response:");
            console.log(result.text);
        } else {
            console.log("\n[Simulated Agent Interaction]");
            console.log("User: List files in current directory.");
            const output = await tools.execute_shell_command.execute({ command: 'ls -F' });
            console.log("Tool Output:", JSON.stringify(output));
        }

    } catch (error) {
        console.error("Agent Error:", error);
    } finally {
        await vm.stop();
    }
}

runAgent();
