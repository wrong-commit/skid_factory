# skid_factory
A tool to automate video game reverse engineering and cheat client development using LLMs and MCP. Proof is provided using the "Not a Hero" single player, DRM free game. 

After finding the the leaf pointer of our health/ammo values, use the `advise` command to have Cursor automate the entire memory reading process, pointer traversal and memory patching efforts. 

In the future, this program will generate a DLL that provides keybindings to restore health to 100%, as a proof of concept.

## Demo

[![Demo: Not a Hero pointer-trace → `write_base_address` ammo to 99](demos/example_hacking_thumb.jpg)](demos/example_hacking_thumb.jpg)

[Watch the demo video](demos/example_hacking.mp4) (~4.5 min) — scan → pointer walk → `save_base_address` → `write_base_address`, with Cursor `advise` in the loop. No human interaction other than reducing player ammo when prompted by the agent.

## Why ?
This took me a couple of afternoons when I was 16 - hours spent recording hexadecimal memory addresses and writing C I barely understood using Win32 API's I would partially grok to memory patch an application. A decade later, I am now able to force my computer to perform this operation for me. If that's not progress, I don't know what is.

## How ?
Use a Node JS script for orchestrating the whole reverse engineering process. Use MCP to interact with the low-level tools: Cheat Engine, x64dbg and Ghidra.. 

Cheat Engine's hardware debugging driver is used to monitor writes to memory addresses for tracing down base addresses. This means techincally this framework is hardware independent.

# Installation Instructions
1. Download Cheat Engine (https://www.cheatengine.org/downloads.php)
2. Download Ghidra (https://github.com/NationalSecurityAgency/ghidra/releases)
3. Install cheat-engine-mcp (https://github.com/Travers9483/mcp-cheat-engine) 
4. Set up MCP bridges for cheat-engine-mcp by running `git clone https://github.com/wrong-commit/mcp-cheat-engine.git`
5. Install Not a Hero from Steam/GOG
6. Install Cursor CLI (https://cursor.com/cli)

# Execution Instructions

## Launch the pointer-trace POC

With Cheat Engine running, the Lua bridge loaded (`bridges/cheat-engine/bridge.lua`), and the game attached:

```bash
npm run poc:trace_pointer
```

(Alias: `npm run poc`.) Disable Cursor’s own CE MCP while the POC runs (it spawns `mcp:start` itself) — see `.cursor/mcp.json.disable`.

Type `help` in the REPL for the full command list.

## Workflow: find a stable base, then patch

Goal: turn a changing heap value (ammo, HP, …) into a **module-static pointer path**, save it, and write through that path safely.

### Case study — Not a Hero ammo (`double`)

1. **Find the value** — scan for the in-game number, change it (fire), filter, repeat until a few candidates remain:
   ```text
   scan double 12
   scan_results 50
   ```
2. **Find what writes it** — watch a candidate while the value changes:
   ```text
   monitor_writes 0C505970 double 5000
   ```
   The dump includes regs, fixed derefs, and ±5 disasm. Ammo was stored by roughly:
   `movsd [eax+0x100], …` with `eax` from `[[[ecx]+0x14]]`.
3. **Walk pointers toward static memory** — scan for the interesting pointer (often a register from the dump, or `[ecx]`), prefer low `00xxxxxx` hits near the exe:
   ```text
   reset_scan
   scan int32 0x0C6BD27C
   scan_results 50
   scan int32 0x987E30
   scan_results 50
   ```
   Empty pointer-scans on a candidate usually mean you’ve hit a **root** (nothing else points at it).
4. **Save the root + path** — include type and offsets (or a path note the POC can parse):
   ```text
   save_base_address 0x989B48 double 0,0,0x14,0x100 ammo [[[base]]+0x14]+0x100
   save_base_address 0x985F48 double 0x888,0x14,0x158 hp
   save_base_address 0x985F48 value double: [[[base]+0x888]+0x14]+0x158
   ```
   That writes `type` + `offsets[]` into `base_addresses.json` automatically.
5. **Patch via the chain — never write the static base itself** (that overwrites a pointer and can crash):
   ```text
   list_bases
   resolve_base 0
   write_base_address 0 99
   ```

### General recipe (any value)

| Step | What to do | POC commands |
| --- | --- | --- |
| 1 | Exact / next-scan until few hits | `scan <type> <value>`, `scan_results` |
| 2 | Write-watch while the value changes | `monitor_writes <addr> <type> <ms>` |
| 3 | Read disasm + regs → expression for the store | (in the dump; optional `disassemble <rip>`) |
| 4 | Pointer-scan upward; keep survivors after level change | `scan int32 <ptr>`, `reset_scan` as needed |
| 5 | Stop at a static root; save with type + offsets | `save_base_address <root> <type> <o1,o2,...> <note>` |
| 6 | Verify + patch leaf only | `resolve_base <idx>`, `write_base_address <idx> <value>` |

**Do not** `poc_patch` a saved base address. Use `poc_patch` only on a resolved leaf (e.g. the address `resolve_base` prints), or always prefer `write_base_address`.

### Advise (Cursor CLI coach)

After any dump or scan, you can ask the POC for next steps (requires Cursor `agent` CLI on PATH):

```text
advise
advise which hit looks static?
advise --run
advise_run
```

`advise --run` / `advise_run` auto-executes allowlisted gather steps and **loops**: each Cursor call gets the full session transcript (prior commands + tool outputs). After `scan_results`, `monitor_writes` JSON, `list_bases`, or `resolve_base`, it re-prompts the agent with the new dump (cap: `ADVISE_MAX_LOOPS`). For `monitor_writes`, press Enter when ready to interact in-game, then Y/n to continue the loop. See [`specs/SPEC_POC_ADVISE_CURSOR_CLI.md`](specs/SPEC_POC_ADVISE_CURSOR_CLI.md).

## Planned (not wired yet)

1. Run `npm run mpc:start` to start the MCP server
2. Run `npm run mcp:status` to check the MCP status (?)
3. Run `npm run game:start` to start the Not a Hero game
4. Run `npm run game:inject` to inject the prebuilt DLL
5. Run `npm run game:stop` to start the Not a Hero game
6. Run `npm run cheat:build` to run the build steps for the DLL library
7. Run `npm run mcp:start` to start he MCP server
8. Run `npm run mcp:start:tools` to launch a instance of each MCP tool. Manually launch the bridge scripts

# Development Steps
1. Complete POC_demo.md and prove that MCP can programtically scan pointer chains with user interaction. **COMPLETE**
2. Add to POC the ability to overwrite WRITE instruction address memory from pointer chain addresses with NOOP
3. Setup https://github.com/BenteVE/DLL-Injector for DLL Injection through CLI. Add agent skill to use for injection
4. Setup C++ DLL library template for cheat to write to (later phase)
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

## JailBreaking
It was not necessary to jailbreak anything in this project. However, `src\advise\build_prompt.ts` contained a prompt that discussed the circular nature of this harness. Including that string triggered the guardrails of this model, so it is interesting that letting the harness know it is in a loop is against the rules.

