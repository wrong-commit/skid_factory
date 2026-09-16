# NEED_A_COOL_TITLE
A tool to automate video game reverse engineering and cheat client development using LLMs and MCP. Proof is provided using the "Not a Hero" single player, DRM free game.

## Why ?
This took me a couple of afternoons when I was 16 - hours spent recording hexadecimal memory addresses and writing custom C I barely understood to memory patch an application. A decade later, I am now able to force my computer to perform this operation for me. If that's not progress, I don't know what is.

## How ?
Use a Node JS script for orchestrating the whole reverse engineering process. Use MCP to interact with the low-level tools: Cheat Engine, x64dbg and Ghidra.. 

Cheat Engine's hardware debugging driver is used to monitor writes to memory addresses for tracing down base addresses. This means techincally this framework is hardware independent.

# Installation Instructions
1. Download Cheat Engine (https://www.cheatengine.org/downloads.php)
2. Download Ghidra (https://github.com/NationalSecurityAgency/ghidra/releases)
3. Install cheat-engine-mcp (https://github.com/Travers9483/mcp-cheat-engine) 
4. Set up MCP bridges for cheat-engine-mcp
5. Install Not a Hero from Steam/GOG

# Execution Instructions
1. Run `npm run mpc:start` to start the MCP server
2. Run `npm run mcp:status` to check the MCP status (?)
3. Run `npm run game:start` to start the Not a Hero game

# Development Steps
1. Complete POC_demo.md and prove that MCP can scan programtically track pointer chains with user interaction
2. Add to POC the ability to overwrite WRITE instruction address memory from pointer chain addresses with NOOP
3. Add transparent GUI overlay for debugging
    - [ ] current task/workflow status
    - [ ] current address spaces scan result count 
    - [ ] currently searched address space value
    - [ ] chain from tail pointer for base address in debug window 
    - [ ] add window for setting write breakpoint on ASM (???)
        This ability is not exposed through Cheat Engine MCP, maybe needs to be implemented manually using debug_setBreakpoint (https://wiki.cheatengine.org/index.php?title=Lua:debug_setBreakpoint). Maybe need to manually reimplement opcode finding from Cheat Engine
    - [ ] view list of ASM instruction addresses that write to the above breakpoint
4. Add keybindings and GUI popups for
    - [ ] address space search (increase/decrease/manual_popup)
    - [ ] restart game
    - [ ] set "monitor writes" breakpoint on any address in filtered list using Cheat Engine MCP and custom Lua to store results. Use keybindings to choose the address in filtered list for "monitor breakpoint", use GUI to show results of rip and locations like 
    ```
    {
    "watched_address": "0x000001F812345678",
    "writes": [
        {
        "rip": "0x00007FF612341234",
        "location": "game.exe+0x1234",
        "count": 1832
        },
        {
        "rip": "0x00007FF612348765",
        "location": "game.exe+0x8765",
        "count": 421
        }
    ]
    }
    ```    
    - [ ] showing the ASM/C for all addresses in the filtered list. This will make it easier to choose which address to pointer chase
    - [ ] choose a new address from the "what wrote to this address" screen to follow. Following means showing ASM, C, and setting a "monitor writes" breakpoint.
    - [ ] GUI for showing all "monitor write" results like Cheat Engine does.
    - [ ] key bindings to navigate the list to follow new entires. Or use clickable buttons
