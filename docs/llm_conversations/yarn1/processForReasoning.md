Yes. There is now a **fairly active ecosystem around exactly this idea**, although I would distinguish it from formal academic research: most of the work I found is **open-source engineering / hobbyist reverse-engineering tooling**, rather than peer-reviewed research.

### The main development: Cheat Engine + MCP + AI agents

The most significant project I found is **Cheat Engine MCP Bridge**:

[cheatengine-mcp-bridge on GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com)

It connects Cheat Engine to AI agents through **Model Context Protocol (MCP)**. The architecture is essentially:

```text
             ┌─────────────────────┐
             │ Claude / Cursor /   │
             │ Copilot / Codex     │
             └──────────┬──────────┘
                        │ MCP
                        ▼
             ┌─────────────────────┐
             │ Python MCP Server   │
             └──────────┬──────────┘
                        │
                 Named pipe / TCP
                        │
                        ▼
             ┌─────────────────────┐
             │ Cheat Engine Lua    │
             │ bridge              │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ Target process      │
             │ memory / code       │
             └─────────────────────┘
```

The project explicitly supports **Cursor and Claude**, among other MCP clients. It exposes functionality such as memory reading, pointer following, structure analysis, disassembly, breakpoints, AOB scanning and code analysis. ([GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com))

Interestingly, the project has grown substantially: its current documentation describes roughly **180 MCP tools**, including memory/process operations, assembly, code injection, symbols, GUI automation and kernel/DBVM functionality. ([Plaud](https://download.plaud.ai/miscusi-peek/cheatengine-mcp-bridge/blob/main/CLAUDE.md?utm_source=chatgpt.com))

### Cursor specifically

This is not merely theoretical. The project's documentation explicitly lists **Cursor** as an MCP client, so the workflow can be:

> "Find the player's health value, determine what writes to it, identify the surrounding structure, and explain what you've found."

The AI can then make successive MCP calls to Cheat Engine rather than merely generating Lua/Auto Assembler code for you. ([GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com))

There are also other implementations. For example, `re-mcp` attempts to unify **Cheat Engine + x64dbg + Ghidra** behind one MCP interface, allowing an AI assistant to move between memory scanning, debugging and decompilation. ([GitHub](https://github.com/Travers9483/mcp-cheat-engine?utm_source=chatgpt.com))

### Claude

Claude is probably the most obvious target because **Claude Code has particularly good MCP/tool-use support**.

There is a separate, simpler Cheat Engine MCP server discussed on the official Cheat Engine forum. It provides commands including:

- memory read/write
- AOB scanning
- address resolution
- disassembly
- Auto Assemble
- calculations

and can be connected to Claude Code or other agent clients. ([Cheat Engine Forum](https://forum.cheatengine.org/viewtopic.php?p=5795047&sid=356f0b8d39cbe6a13f55f26056c96fd3&utm_source=chatgpt.com))

There are also independent implementations such as `ce-mcp`, which expose Cheat Engine's workflow to an AI agent through FastMCP. ([GitHub](https://github.com/IMRX44/MCP?utm_source=chatgpt.com))

### ChatGPT

This is the interesting distinction.

**ChatGPT itself isn't fundamentally different from Claude/Cursor here.** The important technology is MCP/tool calling rather than the particular LLM.

The Cheat Engine MCP Bridge documentation describes the system as working with MCP-compatible agents, and third-party documentation explicitly lists **ChatGPT, Claude Code and Codex** among the potential clients. ([GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com))

So conceptually:

```text
GPT / Claude / Gemini
        │
        │ reasoning
        ▼
       MCP
        │
        ▼
 Cheat Engine
        │
        ▼
 target process
```

The model doesn't need to "understand Cheat Engine" natively. You give it a collection of structured tools such as:

```text
read_memory(address)
scan_memory(value)
aob_scan(pattern)
get_module()
disassemble(address)
find_writes(address)
follow_pointer(...)
```

and the model learns to combine them.

---



## What's actually novel here?

The interesting research direction isn't simply **"AI can read Cheat Engine memory."**

It's **agentic reverse engineering**.

A conventional LLM interaction looks like:

```text
Human → "Write me a Cheat Engine script"
AI   → script
Human → tests it
Human → gives AI error
AI   → modifies script
```

The MCP approach changes this to:

```text
Human → "Find how the game stores player movement."

AI
 ├─ inspect modules
 ├─ inspect memory
 ├─ scan candidate values
 ├─ set breakpoint
 ├─ observe access
 ├─ disassemble surrounding code
 ├─ identify structure
 ├─ formulate hypothesis
 ├─ test hypothesis
 └─ report result
```

That is much closer to an **autonomous reverse-engineering agent**.

The existing bridge explicitly advertises workflows such as finding packet-decryption hooks, locating coordinate-related code, identifying health values and generating resilient AOB signatures. ([GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com))

---



## There are several parallel projects

I found at least four interesting approaches:


| Project                    | CE                     | AI/Agent                   | Other RE tools  | Interesting aspect                 |
| -------------------------- | ---------------------- | -------------------------- | --------------- | ---------------------------------- |
| **cheatengine-mcp-bridge** | ✅                      | Claude/Cursor/Copilot/etc. | —               | Most mature/general CE integration |
| **ce-mcp**                 | ✅                      | Claude/MCP clients         | —               | Simpler architecture               |
| **re-mcp**                 | ✅                      | Claude/Copilot/etc.        | x64dbg + Ghidra | Unified RE agent                   |
| **cheat-engine-mcp**       | CE-like memory tooling | MCP                        | —               | Linux/scanmem-oriented alternative |


The latter, for example, exposes dozens of tools for memory scanning, guarded writes, process management, cheat tables and reverse-engineering reports. ([GitHub](https://github.com/gede-cahya/cheat-engine-mcp?utm_source=chatgpt.com))

And there is even a **Cheat Engine MCP Launcher** intended to make connecting Claude Code/Codex/Gemini CLI to CE essentially one-click. ([GitHub](https://github.com/ikevin127/cheatengine-mcp-launcher?utm_source=chatgpt.com))

---



# What I *don't* see much of yet

This is where I think the genuinely interesting research opportunities are.

I found a lot of **"LLM can control Cheat Engine"** work, but considerably less evidence of rigorous research on:

### 1. Autonomous memory discovery

For example:

> "Given only a running game, autonomously discover the player object, health, position, inventory and relevant functions."

That would be a much stronger research problem than simply giving the LLM `read_memory()`.

### 2. Closed-loop hypothesis testing

An agent could maintain hypotheses:

```text
H1: 0x7FF612340000 + 0x1A8 = player health

confidence: 0.63

Evidence:
  + value changes when damaged
  + value remains stable between frames
  - pointer chain breaks after reload
```

Then deliberately perform experiments to distinguish H1 from H2/H3.

That's much closer to **scientific reasoning / active learning**.

### 3. Combining CE + Ghidra + x64dbg

This is beginning to appear — `re-mcp` is an example — but I think this is one of the most promising directions. ([GitHub](https://github.com/Travers9483/mcp-cheat-engine?utm_source=chatgpt.com))

You could have:

```text
                LLM
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
 Cheat Engine  x64dbg    Ghidra
    │            │          │
 memory       runtime     static
 analysis     analysis    analysis
       └─────────┼─────────┘
                 ▼
          shared RE model
```

That starts resembling an **AI reverse-engineering workstation** rather than "ChatGPT controlling Cheat Engine."

### 4. Persistent knowledge

Another largely unexplored area is allowing the agent to build a persistent model of a binary:

```text
game.exe
 ├── Player
 │    ├── health @ +0x1A8
 │    ├── position @ +0x1C0
 │    └── velocity @ +0x1CC`
 ├── World
 ├── EntityManager
 └── Network
```

Then after an update:

> "The game patched from 1.4.2 → 1.4.3. Revalidate everything."

The agent could use signatures, RTTI, control-flow relationships, pointer chains and previous observations to reconstruct what changed.

**That, in my opinion, is substantially more interesting than simply adding an LLM chat box to Cheat Engine.**

---



## One important caveat

The current projects are primarily **engineering projects and demonstrations**, not controlled academic studies establishing that LLMs reliably outperform experienced reverse engineers. The repositories themselves describe their purpose in terms of research, education, modding, debugging and automation. ([GitHub](https://github.com/miscusi-peek/cheatengine-mcp-bridge?utm_source=chatgpt.com))

So if you're asking **"has someone researched this?"**, the answer is:

**Yes — surprisingly actively on the implementation side.**

If you're asking **"has this been scientifically explored as autonomous AI-assisted reverse engineering?"**, there's still a lot of open territory.

And if your interest is specifically in **building a system where ChatGPT/Cursor/Claude can autonomously operate Cheat Engine, inspect a game, form hypotheses, run scans/breakpoints, and iteratively reverse-engineer it**, that's a much more interesting problem than the existing MCP bridges.

I can also map out the **existing GitHub projects/papers/approaches into a research landscape**, including what each one can actually do and where the unsolved gaps are.