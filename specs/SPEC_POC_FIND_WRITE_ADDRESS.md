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

## Files

| Path | Role |
| --- | --- |
| `src/lua/monitor_writes.lua` | **Source of truth** for CE behavior — edit this to change the watch |
| `src/handlers/monitor_writes.ts` | Loads Lua, builds eval chunk, calls `ce_eval_lua`, parses `WriteDump` |
| `src/mcp/ce_tools.ts` | Catalog entry for `ce_eval_lua` + shared `WriteDumpSchema` |
| `src/poc_trace_pointer.ts` | REPL commands `monitor_writes` / `show_write_locations` |

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
  "writes": [
    { "rip": "0x00007FF612341234", "location": "game.exe+1234", "count": 1832 }
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
```

Successful runs update the POC’s `watched` address to the monitored data address.

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
