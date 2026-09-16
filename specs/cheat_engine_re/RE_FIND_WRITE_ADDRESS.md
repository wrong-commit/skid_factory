The important thing is that **"Find out what writes to this address" is implemented as a memory write breakpoint/watchpoint**, not by scanning every instruction.

### 1. The entry point: `FindWhatWrites`

The main implementation is in:

[Cheat Engine — debughelper.pas](https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debughelper.pas?utm_source=chatgpt.com)

The file declares:

```pascal
procedure FindWhatWrites(address: uint_ptr; size: integer;
                          breakpointmethod: TBreakpointMethod);
```

and related functions:

```pascal
procedure FindWhatAccesses(...);
function SetOnWriteBreakpoint(...);
function SetOnAccessBreakpoint(...);
```

You can see those declarations around the debugger interface in the source. ([GitHub][1])

The architecture is roughly:

```text
FindWhatWrites()
      │
      ▼
SetOnWriteBreakpoint()
      │
      ▼
AddBreakpoint()
      │
      ▼
SetBreakpoint()
      │
      ├── Hardware debug register
      ├── Exception/page-protection breakpoint
      ├── DBVM
      └── other debugger backend
```

Cheat Engine actually supports several breakpoint mechanisms; `TBreakpointMethod` explicitly includes `bpmDebugRegister`, `bpmException`, `bpmDBVM`, etc. ([GitHub][2])

---

## 2. Hardware watchpoint path

For the normal x86/x64 case, the interesting path is the **debug-register breakpoint**.

In `debughelper.pas`, the breakpoint type is:

```pascal
bpmDebugRegister
```

and the trigger can be:

```pascal
bptExecute
bptAccess
bptWrite
```

The source explicitly maps these to execute, read/write, and write breakpoints. ([GitHub][2])

The important section is `SetBreakpoint`, where CE handles:

```pascal
case breakpoint^.breakpointMethod of
  bpmDebugRegister:
  begin
    ...
  end;
```

([GitHub][1])

For network debugging, for example, it converts the CE breakpoint type into:

```pascal
bptExecute → 0
bptWrite   → 1
bptAccess  → 3
```

and passes:

```pascal
networkSetBreakpoint(
    processhandle,
    tid,
    breakpoint.debugRegister,
    breakpoint.address,
    bptype,
    breakpoint.size
);
```

([GitHub][1])

For Windows x86/x64, the lower-level debugger ultimately deals with the CPU debug registers.

---

# 3. What actually happens at the CPU level

Suppose CE wants to watch:

```text
0x12345678
```

for writes.

Conceptually it sets:

```text
DR0 = 0x12345678
DR7 = enable DR0
      write condition
      appropriate length
```

The CPU then executes the target program normally:

```asm
mov [rax+20], ecx
```

Eventually:

```text
RAX = 0x12345658
```

so:

```text
RAX + 0x20
     ↓
0x12345678
```

The CPU recognizes that the store overlaps the address monitored by the debug register and generates a debug exception.

**Crucially, the CPU has already retained the instruction pointer/context.**

So the debugger receives something conceptually equivalent to:

```text
Exception:
    type = debug breakpoint
    RIP  = 0x7FF600123456
    DR6  = breakpoint 0 fired
    registers = ...
```

That `RIP` is the address of the instruction responsible for the access.

---

# 4. Cheat Engine's low-level debugger

The really interesting code is here:

[Cheat Engine — DBKKernel/debugger.c](https://github.com/cheat-engine/cheat-engine/blob/master/DBKKernel/debugger.c?utm_source=chatgpt.com)

This is Cheat Engine's kernel-level debugging implementation. The source describes it as handling debugging functionality including interrupt handling. ([GitHub][3])

There is also an assembly entry point:

```c
extern void interrupt1_asmentry(void);
```

for AMD64. ([GitHub][3])

That is significant because **interrupt vector 1 is the x86 debug exception** (`#DB`).

So the rough low-level path is:

```text
CPU detects DR0/DR7 match
          ↓
       #DB exception
          ↓
interrupt1_asmentry
          ↓
debugger handler
          ↓
inspect saved CPU context
          ↓
RIP = instruction that triggered it
```

---

# 5. DR6 tells CE which breakpoint fired

The CPU provides another debug register:

```text
DR6
```

which contains status bits indicating why the debug exception happened.

Cheat Engine's kernel debugger explicitly manipulates/reads DR6. For example, the source contains logic around:

```c
_dr6.BD = 0;
```

and stores the resulting debug state in its debugger state. ([GitHub][3])

This matters because there can be multiple hardware breakpoints:

```text
DR0 → watched address A
DR1 → watched address B
DR2 → watched address C
DR3 → watched address D
```

When the exception occurs, DR6 tells the handler which debug condition triggered.

---

# 6. Then CE gets the instruction pointer

The saved context contains the instruction pointer.

On x86-64 that's:

```text
RIP
```

So if the program was executing:

```asm
Game.exe+123456:
mov [rax+20],ecx
```

when the watched memory was written, the exception context gives CE approximately:

```text
RIP = Game.exe+123456
```

CE can then read the instruction bytes at that address and disassemble them.

That's how it can display:

```asm
mov [rax+20],ecx
```

rather than merely saying:

```text
0x7FF612345678 was modified
```

---

# 7. There's an additional clever part

There's an interesting wrinkle in Cheat Engine's kernel debugger.

The source doesn't blindly assume that every `#DB` was generated by the target's debug registers. It maintains/fakes debug-register state in some circumstances.

You can see code in `debugger.c` that examines the instruction causing the debug exception and handles accesses to the debug registers themselves. ([GitHub][3])

That's part of Cheat Engine's more sophisticated debugger implementation and is one reason the source is considerably more complicated than a minimal debugger.

---

# 8. What about VEH?

Cheat Engine also has a user-mode **VEH debugger**:

[Cheat Engine — VEHDebugger.pas](https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/VEHDebugger.pas?utm_source=chatgpt.com)

VEH = **Vectored Exception Handling**.

This gives CE another mechanism for receiving exceptions without necessarily using the traditional Windows debugger architecture.

The source is ~800 lines and contains the VEH debugger implementation. ([GitHub][4])

So depending on the selected debugger/backend, the exact path differs.

---

# 9. The really useful source file to study

If your goal is **"I want to implement my own simplified version of Find What Writes"**, I'd start here:

[`debughelper.pas`](https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debughelper.pas?utm_source=chatgpt.com)

Then follow these symbols:

```text
FindWhatWrites
    ↓
SetOnWriteBreakpoint
    ↓
AddBreakpoint
    ↓
SetBreakpoint
    ↓
bpmDebugRegister
    ↓
debug-register implementation
```

Then study:

[`debuggertypedefinitions.pas`](https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debuggertypedefinitions.pas?utm_source=chatgpt.com)

particularly:

```pascal
TBreakpointMethod
TBreakpointTrigger
```

The source explicitly defines:

```pascal
TBreakpointMethod = (
    bpmInt3,
    bpmDebugRegister,
    bpmException,
    bpmDBVM,
    bpmDBVMNative,
    bpmGDB
);
```

and:

```pascal
TBreakpointTrigger = (
    bptExecute,
    bptAccess,
    bptWrite
);
```

([GitHub][2])

---

## One important correction to my previous answer

I made the mechanism sound more Windows-specific than it actually is.

Modern Cheat Engine has **multiple debugger implementations and architectures**. The source supports hardware debug registers, exception-based breakpoints, DBVM, GDB/network debugging, and ARM64 watchpoints among others. `debughelper.pas` explicitly branches between these implementations. ([GitHub][1])

For ARM64, for example, CE directly configures the architecture's breakpoint/watchpoint registers in the saved thread context. The source sets the watchpoint address (`WVR`) and configures the load/store control register (`WCR`) for `bptAccess` versus `bptWrite`. ([GitHub][1])

So the **core idea is universal**:

```text
             watched memory
                   │
                   ▼
        ┌─────────────────────┐
        │ CPU hardware / OS   │
        │ memory watchpoint   │
        └──────────┬──────────┘
                   │
                   │ exception
                   ▼
             debugger handler
                   │
                   ▼
             saved CPU context
                   │
                   ▼
             instruction IP
                   │
                   ▼
          disassemble instruction
                   │
                   ▼
       "mov [rax+20], ecx"
```

That's the fundamental trick: **you don't need to figure out beforehand which instruction accesses the address. You ask the processor to stop when the address is accessed, and then the exception context tells you which instruction was executing.**

The Cheat Engine wiki also describes the feature explicitly as setting a breakpoint on the address and showing the instructions accessing it. ([Cheat Engine][5])

If you want, I can go one level deeper and walk through the **actual x86-64 `DR0–DR7` setup and the `#DB → DR6 → RIP` path**, including a small C/C++ implementation of a Windows hardware write breakpoint.

[1]: https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debughelper.pas "cheat-engine/Cheat Engine/debughelper.pas at master · cheat-engine/cheat-engine · GitHub"
[2]: https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debuggertypedefinitions.pas?utm_source=chatgpt.com "cheat-engine/Cheat Engine/debuggertypedefinitions.pas at master · cheat-engine/cheat-engine · GitHub"
[3]: https://github.com/cheat-engine/cheat-engine/blob/master/DBKKernel/debugger.c?utm_source=chatgpt.com "cheat-engine/DBKKernel/debugger.c at master · cheat-engine/cheat-engine · GitHub"
[4]: https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/VEHDebugger.pas?utm_source=chatgpt.com "cheat-engine/Cheat Engine/VEHDebugger.pas at master · cheat-engine/cheat-engine · GitHub"
[5]: https://wiki.cheatengine.org/index.php?title=Help_File%3AFind_out_what_writes%2Faccesses_this_address&utm_source=chatgpt.com "Help File:Find out what writes/accesses this address - Cheat Engine"

# Implementing with MCP
Yes. For an MCP integration, the cleanest approach is to have **Cheat Engine Lua own the breakpoint and return a JSON-ish table of unique RIPs** to your MCP bridge.

The relevant CE API is exactly `debug_setBreakpoint(address, size, bptWrite, ...)`; CE's Lua debugger exposes `RIP` on 64-bit targets inside `debugger_onBreakpoint()`. ([Cheat Engine][1])

One important distinction: **the watched address is the data address; `RIP` is the instruction address that performed the write.**

### Minimal CE Lua implementation

```lua
-- Start debugging if necessary
if not debug_isDebugging() then
    debugProcess()
end

local watchedAddress = 0x123456789ABC
local watchedSize = 4

local hits = {}
local hitCount = 0

-- Called whenever the write breakpoint fires
function debugger_onBreakpoint()
    local rip = RIP

    if not hits[rip] then
        hits[rip] = {
            rip = rip,
            count = 0
        }
        hitCount = hitCount + 1
    end

    hits[rip].count = hits[rip].count + 1

    -- Continue execution
    debug_continueFromBreakpoint(co_run)

    -- Tell CE that we've handled the breakpoint
    return 1
end

-- bptWrite = 2
debug_setBreakpoint(
    watchedAddress,
    watchedSize,
    bptWrite
)

print(string.format(
    "Watching writes to 0x%X",
    watchedAddress
))
```

CE documents `bptWrite` as the breakpoint type that fires when the specified memory region is written. ([Cheat Engine][1])

And on 64-bit CE, `RIP` is one of the register variables populated when `debugger_onBreakpoint()` is invoked. ([Cheat Engine][2])

### Retrieving the results

You can expose the results to your MCP layer with a Lua function:

```lua
function getWriteBreakpointResults()
    local result = {}

    for rip, info in pairs(hits) do
        result[#result + 1] = {
            address = string.format("0x%016X", rip),
            count = info.count
        }
    end

    table.sort(result, function(a, b)
        return a.address < b.address
    end)

    return result
end
```

You'd then get something conceptually like:

```json
[
  {
    "address": "0x00007FF612341234",
    "count": 1832
  },
  {
    "address": "0x00007FF612348765",
    "count": 421
  },
  {
    "address": "0x00007FF612349999",
    "count": 17
  }
]
```

Those `address` values are the **RIPs of the instructions that actually triggered the write watchpoint**.

---

## For MCP, I'd structure it slightly differently

I'd make the CE Lua side into a small stateful service:

```text
MCP
 │
 ├── watch_memory(address, size)
 │       │
 │       └── CE Lua:
 │             debug_setBreakpoint(...)
 │
 ├── get_write_hits()
 │       │
 │       └── CE Lua:
 │             return { RIP → count }
 │
 └── stop_watch(address)
         │
         └── CE Lua:
               debug_removeBreakpoint(address)
```

For example:

```lua
local watches = {}

function startWriteWatch(address, size)
    if watches[address] then
        return false, "already watching"
    end

    watches[address] = {
        address = address,
        size = size,
        hits = {}
    }

    debug_setBreakpoint(
        address,
        size,
        bptWrite
    )

    return true
end


function debugger_onBreakpoint()
    local rip = RIP

    -- In a real implementation, associate this hit with
    -- the relevant watch/breakpoint.

    for address, watch in pairs(watches) do
        -- Record the instruction address
        watch.hits[rip] = (watch.hits[rip] or 0) + 1
    end

    debug_continueFromBreakpoint(co_run)
    return 1
end


function getWriteHits(address)
    local watch = watches[address]

    if not watch then
        return nil
    end

    local result = {}

    for rip, count in pairs(watch.hits) do
        result[#result + 1] = {
            rip = string.format("0x%016X", rip),
            count = count
        }
    end

    return result
end
```

**But I would change that implementation before using it in MCP**, because the `debugger_onBreakpoint()` callback doesn't inherently tell you "which watch object" fired. You should associate the breakpoint address with its own callback or maintain a mapping based on the breakpoint configuration.

CE actually supports passing a **Lua callback directly to `debug_setBreakpoint`**, which is particularly useful here. The documented signature is:

```text
debug_setBreakpoint(
    address,
    size,
    trigger,
    breakpointmethod,
    functiontocall
)
```

and the callback can be supplied directly. ([Cheat Engine][1])

So an MCP-friendly version can avoid one global `debugger_onBreakpoint()` dispatcher per watch.

---

## One major issue: hardware breakpoint limits

If you use:

```lua
debug_setBreakpoint(
    address,
    size,
    bptWrite,
    bpmDebugRegister,
    callback
)
```

you're asking CE to use a hardware debug-register breakpoint.

On x86/x64 there are only a **small number of hardware breakpoint slots**. CE's own source has explicit logic for allocating usable debug registers and determining the maximum breakpoint count. ([GitHub][3])

Therefore, for your MCP interface, I would **not expose "create unlimited write watches"** as the abstraction.

Instead:

```text
start_write_trace(address, size)
        ↓
one active hardware watch
        ↓
collect potentially thousands of hits
        ↓
deduplicate RIPs
        ↓
return results
        ↓
stop_write_trace()
```

That's much closer to what CE's "Find out what writes to this address" functionality is doing. CE's own documentation describes that feature as setting a breakpoint on the address and recording each instruction that accesses it, including a hit counter. ([Cheat Engine][4])

---

## Also: don't confuse `RIP` with the instruction bytes

For MCP I'd actually return **both**:

```json
{
  "rip": "0x00007FF612341234",
  "module": "game.exe",
  "offset": "0x1234",
  "count": 1832
}
```

You can get a symbolic/module representation using CE's address functions such as `getNameFromAddress()` / `getAddress()`, which are part of the Lua scripting API. ([Cheat Engine][5])

That lets your MCP response become:

```json
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

That's substantially more useful to an LLM than just returning raw addresses.

### One more useful improvement

If your MCP tool's purpose is specifically **"find what writes this address"**, I would make the MCP operation synchronous from the user's perspective:

```text
mcp.find_writers(address, size, duration)
```

Internally:

```text
          MCP
           │
           ▼
    CE Lua script
           │
           ├── set bptWrite
           │
           ├── resume game
           │
           ├── collect RIPs
           │      │
           │      ├── RIP A × 1832
           │      ├── RIP B × 421
           │      └── RIP C × 17
           │
           ├── stop/remove breakpoint
           │
           ▼
      JSON results
```

That avoids leaving a breakpoint active after the MCP request completes.

If you tell me **how your MCP ↔ Cheat Engine bridge currently communicates** (e.g. CE Lua socket, HTTP, named pipe, your existing `cheatengine-mcp-bridge`, etc.), I can give you the actual **MCP tool + CE Lua implementation**, including the callback, timeout, breakpoint cleanup, RIP deduplication, module+offset resolution, and JSON serialization.

[1]: https://wiki.cheatengine.org/index.php?title=Lua%3Adebug_setBreakpoint&utm_source=chatgpt.com "Lua:debug setBreakpoint - Cheat Engine"
[2]: https://wiki.cheatengine.org/index.php?title=Lua_Debugging&utm_source=chatgpt.com "Lua Debugging - Cheat Engine"
[3]: https://github.com/cheat-engine/cheat-engine/blob/master/Cheat%20Engine/debughelper.pas?utm_source=chatgpt.com "cheat-engine/Cheat Engine/debughelper.pas at master · cheat-engine/cheat-engine · GitHub"
[4]: https://wiki.cheatengine.org/index.php?title=Help_File%3AFind_out_what_writes%2Faccesses_this_address&utm_source=chatgpt.com "Help File:Find out what writes/accesses this address - Cheat Engine"
[5]: https://wiki.cheatengine.org/index.php?title=Lua%3Adebug_getBreakpointList&utm_source=chatgpt.com "Lua:debug getBreakpointList - Cheat Engine"
