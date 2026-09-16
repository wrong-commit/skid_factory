# POC To Demonstrate Capabilities of Tools

## Steps

1. Init repo
2. Download, build, install cheat-engine-mcp tool
3. Configure Codex to use MCP server for repository
4. Purchase, download, install, "Not A Hero"
5. Start Cheat Engine, MCP Server
6. Use Node JS Repl(?) to try fetching addresses for health value with Cheat Engine
7. Search a few times until address list reduces, use scan_next to filter list.
8. Use Ghidra ghidra_decompile/ghidra_disassemble to dump surrounding code for ASM investigation
9. Write a piece of JS that
  - takes in a memory address
    - figures out what ASM instruction addresses write to this memory address using CPU debug registers (wtf how)
    - dumps the C/ASM/registers into a JSON and provide to Chat GPT
    - use sub-agent LLM reasoning to determine what ASM opcode line instruction address to overwrite with a NOOP
    - dumps the base address value of the instruction to overwite. Let me manually make this change and test in Cheat Engine. Do not worry about calling MCP ce_write_memory to patch instruction address opcode yet.
10. Once the above is working, begin working on the `llm_conversations\yarn2\DESIGN.md`

## What does this prove?

The JS and MCP can be used to 

1. interact with Cheat Engine
2. disassemble/decompile instruction addresses
3. programatically in loop detect base address using memory inspection, ASM decompilation/disassemblement, and copying addresses between tools
4. A greater loop could probably be used to resolve this automatically.



## What does this not prove?

1. That JS is a good cheating tool



## What do I foresee as an issue ?

Tracking down base addresses from pointed address. Tracing base addresses requires tracking every location that writes to the aforementioned address. This can probably be implemented with debugging. How?

## How do the tools work together?

Cheat Engine MCP can be used to find the initial value, then the x64dbg MCP can be used to set a write breakpoint on the found address. When the x64dbg breakpoint fires, the user must manually say "