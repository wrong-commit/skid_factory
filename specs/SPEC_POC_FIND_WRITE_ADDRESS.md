# SPEC: POC Find Write Address (`ce_monitor_writes`)

Status: implemented (skeleton; needs live CE MCP `ce_eval_lua` shape confirmation)  
Background: [`cheat_engine_re/RE_FIND_WRITE_ADDRESS.md`](./cheat_engine_re/RE_FIND_WRITE_ADDRESS.md)  
Typed MCP catalog: [`SPEC_MCP_CALL_TYPE_SAFETY.md`](./SPEC_MCP_CALL_TYPE_SAFETY.md)

## Goal

Expose a **custom** operation `ce_monitor_writes` (app-level, not a native CE MCP tool) that answers:

> Which instruction RIPs wrote to this data address?

by running editable Cheat Engine Lua through the bridge tool **`ce_eval_lua`**.

## Non-goals

- Unlimited concurrent hardware watches (x86/x64 has few DR slots).
- Leaving breakpoints active after the call returns.
- Replacing CE’s UI “Find out what writes to this address” for interactive debugging.

## Architecture

```text
REPL / caller
    │
    ▼
handlers/monitor_writes.ts   ← custom ce_monitor_writes
    │  reads src/lua/monitor_writes.lua
    │  substitutes address / size / durationMs
    ▼
callTool(mcp, CeTool.EvalLua, { code })   ← MCP name: ce_eval_lua
    │
    ▼
Cheat Engine Lua
    ensure debugging
    debug_setBreakpoint(addr, size, bptWrite, bpmDebugRegister, callback)
    sleep(durationMs)          ← game keeps running; hits accumulate
    debug_removeBreakpoint(addr)
    return WriteDump JSON string
    │
    ▼
WriteDumpSchema (Zod)
```

One hardware write watch at a time. Collect many hits, **dedupe by RIP**, return counts + module names.

## Distinction: data address vs instruction RIP

| Field | Meaning |
| --- | --- |
| `watched_address` | **Data** address being written |
| `writes[].rip` | **Instruction** address (`RIP`) that performed the write |
| `writes[].location` | Symbolic form from `getNameFromAddress` (e.g. `game.exe+1234`) |
| `writes[].count` | How many times that RIP hit during the window |
| `writes[].regs` | All available GPRs/flags as hex (first hit for this RIP) |
| `writes[].derefs` | Fixed `[ecx]` / `[ecx+4]` / `[eax+0x100]` reads (first hit) |
| `writes[].disasm` | ±5 instructions around the hit RIP (`target: true` on the RIP line) |

## Files

| Path | Role |
| --- | --- |
| `src/lua/monitor_writes.lua` | **Source of truth** for timed write-watch collect |
| `src/lua/remove_write_breakpoint.lua` | `debug_removeBreakpoint` for previous watch |
| `src/lua/set_write_breakpoint.lua` | Persistent `bptWrite` for `follow_address` |
| `src/handlers/monitor_writes.ts` | Loads Lua, builds eval chunk, calls `ce_eval_lua`, parses `WriteDump` |
| `src/handlers/write_breakpoint.ts` | `followWriteAddress` → remove previous + set target |
| `src/mcp/ce_tools.ts` | Catalog entry for `ce_eval_lua` + shared `WriteDumpSchema` |
| `src/poc_trace_pointer.ts` | REPL commands `monitor_writes` / `show_write_locations` / `follow_address` |

## Lua contract (`monitorWrites`)

Defined in `src/lua/monitor_writes.lua`:

```lua
function monitorWrites(address, size, durationMs) --> JSON string
```

The handler appends:

```lua
return monitorWrites(<address_decimal>, <size>, <durationMs>)
```

Returned JSON must match `WriteDumpSchema`:

```json
{
  "watched_address": "0x000001F812345678",
  "type": "double",
  "size": 8,
  "writes": [
    {
      "rip": "0x00007FF612341234",
      "ripRaw": "1407001234567892",
      "location": "game.exe+1234",
      "count": 1832,
      "regs": { "EAX": "0x...", "ECX": "0x...", "EIP": "0x..." },
      "derefs": {
        "[ecx]": "0x...",
        "[ecx+4]": "0x...",
        "[eax+0x100]": "0x..."
      },
      "disasm": [
        { "address": "...", "bytes": "...", "opcode": "movsd [eax+100],xmm0", "target": false },
        { "address": "...", "bytes": "...", "opcode": "add eax,08", "target": true }
      ]
    }
  ]
}
```

## Handler API

```ts
await monitorWrites(mcp, {
  address: "0x12345678", // or decimal string/number
  size: 4,               // default 4
  durationMs: 3000,      // default 3000
});
```

## REPL

```text
monitor_writes <addr> [size=4] [durationMs=3000]
monitor_writes                 # uses current watched address
show_write_locations           # alias: watched address, size=4, 3000ms
follow_address <loc|hex>       # debug_removeBreakpoint(previous) + setWriteBreakpoint(target)
```

`follow_address` clears the previous data-address write watch (if any) via `src/lua/remove_write_breakpoint.lua`, then sets a new `bptWrite` on the target via `src/lua/set_write_breakpoint.lua`. Successful runs update the POC’s `watched` address.

## MCP dependency

| Tool | Required | Notes |
| --- | --- | --- |
| `ce_eval_lua` | **yes** | Args: `{ code: string }`. Result must yield a string (payload itself or `result` / `value` / `output`). |
| `get_write_locations` | no | Deprecated path; custom Lua replaces it for this POC. |

**FIXME:** confirm exact `ce_eval_lua` request/response fields against the installed CE MCP bridge and tighten `CeEvalLuaResultSchema`.

## Why Lua owns the breakpoint

CE already implements write watchpoints via debug registers / other backends. The Lua debugger API (`debug_setBreakpoint` + `RIP` in the callback) is the supported way to mirror “Find what writes” without reimplementing `#DB` handling in Node. See `RE_FIND_WRITE_ADDRESS.md` for the CPU / CE source path.

## Acceptance criteria

- [x] Write-watch logic lives in a standalone `.lua` file (not inlined in TS).
- [x] Handler is isolated under `src/handlers/monitor_writes.ts`.
- [x] Handler only talks to CE through typed `callTool(..., CeTool.EvalLua, ...)`.
- [x] Result validated as `WriteDump`.
- [x] REPL can invoke the flow without a native `get_write_locations` tool.
- [ ] Live integration: attach to a process, confirm hits appear while the game writes the address.
- [ ] Confirm `bptWrite` / `bpmDebugRegister` / `sleep` / `getNameFromAddress` on the installed CE build.

## Out of scope follow-ups

- Multi-address watch queue / soft breakpoints when DR slots are exhausted.
- Streaming partial hits before `durationMs` ends.
- Auto-following the hottest RIP into the next `monitor_writes` (LLM loop).

## Hit payload: regs + fixed derefs + disasm

On the **first** hit per RIP, Lua snapshots regs/derefs. After the watch window ends, it disassembles ±5 instructions around each unique RIP:

| Field | Contents |
| --- | --- |
| `regs` | All available CE debugger GPRs/flags (`EAX`…`EIP`, `RAX`…`R15`, `EFLAGS`/`RFLAGS`) as hex strings |
| `derefs` | Fixed expressions only: `[ecx]`, `[ecx+4]`, `[eax+0x100]` (uses `EAX`/`ECX`, else `RAX`/`RCX`); values via `readInteger` |
| `disasm` | Same instruction shape as `ce_disassemble`; `target: true` marks the reported RIP (often post-store) |

Opcode-driven “which regs/derefs matter” is **out of scope**. See TODO in `src/lua/monitor_writes.lua` for a brief SPEC sketch (parse ModR/M / CE disasm, emit `used_regs` + operand `derefs` only).
