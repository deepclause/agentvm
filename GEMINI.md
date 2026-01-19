# AgentVM

The goal is to create a small npm installable package that contains the .wasm file in this directory and runs it using WASI in a separate thread or process. 

The wasm contains a full blown emaulator that runs a linux vm, by default it boots into a shell. 

Create nice library called agentvm.

requirements
1. only use javascript and node js capabilities
2. create a small wrapper that can instiate a vm, keep it running and wait for commands to be executed in the shell
3. all output from the machine should be captured (ideally possible to stream to host)

produce a small example where the library is used by a simple vercel ai sdk agent that can use the vm as a tool.

First, design the library (may not depend on any rust components or external wasm runtimes)
Then create testcases
Then implement the library until finished.

