# SPEC: MCP Call Type Safety

Status: draft (skeleton implemented in `src/mcp/ce_tools.ts`)  
Applies to: Cheat Engine MCP calls from the Node POC (`poc_trace_pointer` and future orchestration)

## Goal

Make every MCP `tools/call` compile-time safe for **tool name → args → result**, and runtime-safe via **Zod** parsing of the MCP payload. Call sites must not invent result shapes with `as WriteDump`.

## Non-goals

- Auto-generating schemas from live `tools/list` JSON Schema (nice-to-have later).
- Typing Codex / LLM prompts.
- Replacing the REPL command ABI.

## Design choice: catalog map, not `enum`

| Option | Verdict |
| --- | --- |
| TypeScript `enum` of tool names | Rejected — no per-tool args/result coupling |
| Bare `callTool<T>(name: string)` | Rejected — caller can lie about `T` |
| `as const` name object + catalog map | **Chosen** |

Canonical names live in `CeTool`:

```ts
export const CeTool = {
  ScanFirst: "ce_scan_first",
  // ...
} as const;
```

Keys of the catalog **are** the live MCP tool name strings. Renaming a bridge tool means updating `CeTool` and the catalog entry together.

## Type model

```text
CeToolName = values of CeTool
CeToolCatalog[name] = { args: ZodSchema, result: ZodSchema }
CeToolMap[name] = {
  args:   z.infer<catalog[name].args>
  result: z.infer<catalog[name].result>
}
```

`callTool` signature:

```ts
async function callTool<N extends CeToolName>(
  client: Client,
  name: N,
  args: CeToolMap[N]["args"],
): Promise<CeToolMap[N]["result"]>
```

Effects:

1. Invalid tool string → compile error.
2. Wrong args for that tool → compile error (+ Zod parse before send).
3. Return type follows the tool → no cast at call site.
4. Unexpected MCP payload → Zod throws at runtime.

## Runtime pipeline

```text
args
  → catalog[name].args.parse(args)
  → client.callTool({ name, arguments })
  → extractMcpJsonPayload(raw)
  → catalog[name].result.parse(payload)
  → CeToolMap[N]["result"]
```

### `extractMcpJsonPayload` (skeleton)

MCP `CallToolResult` is not the domain object. Prefer, in order:

1. `structuredContent` when present.
2. Concatenate `content[]` text blocks and `JSON.parse`.
3. If parse fails, return raw text string (schema may accept or reject).

Throw when `isError === true` or when there is no usable content.

**FIXME:** harden for multiple content types, resource links, partial JSON, and bridge-specific envelopes.

## Catalog entries (POC)

| `CeTool` | MCP name (current) | Args | Result schema |
| --- | --- | --- | --- |
| `ScanFirst` | `ce_scan_first` | `pid`, `value`, `type` | `CeScanResultSchema` (placeholder) |
| `ScanNext` | `ce_scan_next` | same | same |
| `GetWriteLocations` | `get_write_locations` | `address` | `WriteDumpSchema` |
| `Disassemble` | `disassemble` | `address` | `DisassembleResultSchema` (placeholder) |

**FIXME:** align `GetWriteLocations` / `Disassemble` (and scan result fields) with the installed CE MCP bridge’s real tool names and JSON shapes. Until then, connect-time `REQUIRED_CE_TOOLS` checks will fail against a mismatched server — that is intentional.

## Connect-time checks

On `connectCeMcp`:

1. `listTools()`.
2. Assert every `REQUIRED_CE_TOOLS` name is present.
3. Fail fast with available tool names listed.

Optional later: validate advertised `inputSchema` against catalog args (JSON Schema ↔ Zod), or generate Zod from `tools/list`.

## Adding a new tool

1. Add string to `CeTool`.
2. Add args + result Zod schemas.
3. Register in `ceToolCatalog`.
4. Add to `REQUIRED_CE_TOOLS` if the POC requires it at startup.
5. Call via `callTool(mcp, CeTool.X, { ... })` only — never raw `client.callTool` from feature code.
6. Capture one real MCP response in debug logs and tighten the result schema (drop placeholders).

## Error handling policy

| Failure | Behavior |
| --- | --- |
| Args fail Zod | Throw before MCP call |
| MCP `isError` | Throw with raw payload snippet |
| Result fail Zod | Throw (`ZodError`); do not return partial data |
| Missing required tool at connect | Throw; do not enter REPL |

POC may keep `MCP RESULT DEBUG` logging until schemas stabilize.

## File layout

| Path | Role |
| --- | --- |
| `src/mcp/ce_tools.ts` | `CeTool`, catalog, extract/parse, `callTool` |
| `src/poc_trace_pointer.ts` | REPL; imports typed `callTool` |
| `specs/SPEC_MCP_CALL_TYPE_SAFETY.md` | This document |

## Acceptance criteria

- [x] No untyped `callTool(client, string, Record<string, unknown>): Promise<unknown>` in the POC path.
- [x] Zod schemas exist for each catalogued tool (placeholders allowed until bridge confirmed).
- [x] Connect asserts required tool names.
- [ ] Schemas match a real CE MCP bridge response (integration pass).
- [ ] `GetWriteLocations` / `Disassemble` names confirmed against installed server.
- [ ] Optional: golden fixtures under `tests/mcp/` for `extractMcpJsonPayload` + `parseToolResult`.

## Out of scope follow-ups

- Per-bridge adapters if multiple CE MCP implementations are supported (`BridgeId` → name remaps).
- Sharing the same catalog with Cursor/Codex config generation.
