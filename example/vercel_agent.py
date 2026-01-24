import os
import sys
import json
import subprocess
from openai import OpenAI

# Try to load .env if available, but don't fail if not
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

class AgentVMClient:
    def __init__(self):
        # Path to bridge script relative to this file
        self.bridge_path = os.path.join(os.path.dirname(__file__), 'agent_bridge.js')
        self.process = None
        
    def start(self):
        print("Booting VM...", file=sys.stderr)
        self.process = subprocess.Popen(
            ['node', self.bridge_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr, # Forward stderr (logs) to user console
            text=True,
            bufsize=1
        )
        
        # Wait for READY signal
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("VM process exited unexpectedly")
            if line.strip() == "READY":
                break
            
        print("VM Ready.", file=sys.stderr)

    def exec(self, command):
        if not self.process:
            raise RuntimeError("VM not started")
            
        req = json.dumps({"cmd": "exec", "command": command})
        self.process.stdin.write(req + "\n")
        self.process.stdin.flush()
        
        resp_line = self.process.stdout.readline()
        if not resp_line:
            raise RuntimeError("VM closed connection")
            
        resp = json.loads(resp_line)
        if resp.get('status') == 'ok':
            return resp['result']
        else:
            raise RuntimeError(f"VM Error: {resp.get('error')}")

    def stop(self):
        if self.process:
            try:
                self.process.stdin.write(json.dumps({"cmd": "stop"}) + "\n")
                self.process.stdin.flush()
                self.process.wait(timeout=2)
            except:
                self.process.kill()
            self.process = None

def run_agent():
    vm = AgentVMClient()
    try:
        vm.start()
        
        # Define tools
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "execute_shell_command",
                    "description": "Execute a shell command in a sandboxed Linux environment. Use this to run Python scripts, check files, or perform calculations.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {
                                "type": "string",
                                "description": "The shell command to execute (e.g., \"ls -la\", \"python3 -c ...\")"
                            }
                        },
                        "required": ["command"]
                    }
                }
            }
        ]

        # Check for API Key
        api_key = os.environ.get("OPENAI_API_KEY")
        
        if api_key:
            client = OpenAI(api_key=api_key)
            messages = [
                {"role": "user", "content": "Calculate the 10th Fibonacci number using Python and tell me the result."}
            ]

            MAX_STEPS = 5
            step = 0

            while step < MAX_STEPS:
                step += 1
                response = client.chat.completions.create(
                    model="gpt-4-turbo",
                    messages=messages,
                    tools=tools,
                    tool_choice="auto" 
                )
                
                message = response.choices[0].message
                messages.append(message)
                
                if not message.tool_calls:
                    print("\nAgent Response:")
                    print(message.content)
                    break
                
                for tool_call in message.tool_calls:
                    if tool_call.function.name == "execute_shell_command":
                        args = json.loads(tool_call.function.arguments)
                        command = args["command"]
                        print(f"[Tool] Executing: {command}", file=sys.stderr)
                        
                        cmd_res = vm.exec(command)
                        
                        # Format output as in JS version
                        if cmd_res['exitCode'] != 0:
                            content = f"Error (Exit {cmd_res['exitCode']}): {cmd_res['stderr'] or cmd_res['stdout']}"
                        else:
                            content = cmd_res['stdout']
                            
                        messages.append({
                            "tool_call_id": tool_call.id,
                            "role": "tool",
                            "name": "execute_shell_command",
                            "content": content
                        })                
        else:
            # Simulation Mode (No API Key)
            print("\n[Simulated Agent Interaction]")
            print("User: List files in current directory.")
            res = vm.exec('ls -F')
            print("Tool Output:", json.dumps(res))

    except Exception as e:
        print(f"Agent Error: {e}", file=sys.stderr)
    finally:
        vm.stop()

if __name__ == "__main__":
    run_agent()
