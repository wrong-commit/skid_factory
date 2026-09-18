/**
 * Custom ce_monitor_writes: run CE Lua write-watch via MCP ce_eval_lua.
 * Spec: specs/SPEC_POC_FIND_WRITE_ADDRESS.md
 * Lua source of truth: src/lua/monitor_writes.lua
 */

import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    isSymbolicAddressSpec,
    normalizeAddressSpec,
} from "../address_spec.ts";
import {
    CeTool,
    WriteDumpSchema,
    callTool,
    ceScanTypeFromSize,
    ceScanTypeSize,
    type CeScanType,
    type WriteDump,
} from "../mcp/ce_tools.ts";

const MONITOR_WRITES_LUA_URL = new URL("../lua/monitor_writes.lua", import.meta.url);

export type MonitorWritesArgs = {
    /**
     * Data address to watch: hex `0x...` / bare hex / decimal, or CE
     * `module+offset` (including spaced names like `NOT A HERO.exe+1FF50D`).
     */
    address: string | number;
    /** re-mcp / CE scan type. Default int32 (or inferred from `size`). */
    type?: CeScanType;
    /** Watch size in bytes. Default from `type`, else 4. */
    size?: number;
    /** How long CE collects hits before removing the breakpoint. Default 3000. */
    durationMs?: number;
};

const DEFAULT_TYPE: CeScanType = "int32";
const DEFAULT_DURATION_MS = 3000;

export function resolveMonitorWritesTypeAndSize(args: {
    type?: CeScanType;
    size?: number;
}): { type: CeScanType; size: number } {
    if (args.type !== undefined) {
        return { type: args.type, size: args.size ?? ceScanTypeSize(args.type) };
    }
    if (args.size !== undefined) {
        return {
            type: ceScanTypeFromSize(args.size) ?? DEFAULT_TYPE,
            size: args.size,
        };
    }
    return { type: DEFAULT_TYPE, size: ceScanTypeSize(DEFAULT_TYPE) };
}

/** Parse a numeric address into a Lua-safe unsigned integer literal. */
export function parseMonitorAddress(address: string | number): bigint {
    if (typeof address === "number") {
        if (!Number.isFinite(address) || address < 0) {
            throw new Error(`Invalid monitor address: ${address}`);
        }
        return BigInt(Math.trunc(address));
    }

    const trimmed = address.trim();
    // Explicit 0x... hex
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
        return BigInt(trimmed);
    }
    // Bare hex from CE (e.g. 0C505970 / 0DE216C8): has A–F, or long hex address
    if (/^[0-9A-Fa-f]+$/i.test(trimmed) && (/[A-Fa-f]/.test(trimmed) || trimmed.length >= 8)) {
        return BigInt(`0x${trimmed}`);
    }
    // Decimal digits only
    if (/^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
    }
    throw new Error(
        `Invalid monitor address: ${JSON.stringify(address)} (expected hex 0x... / bare hex like 0C505970, decimal, or module+offset)`,
    );
}

function extractEvalLuaText(raw: unknown): string {
    if (typeof raw === "string") {
        return raw;
    }
    if (raw !== null && typeof raw === "object") {
        const obj = raw as { result?: unknown; value?: unknown; output?: unknown };
        for (const key of ["result", "value", "output"] as const) {
            const v = obj[key];
            if (typeof v === "string") {
                return v;
            }
        }
    }
    throw new Error(
        `ce_eval_lua did not return a JSON string WriteDump: ${JSON.stringify(raw)}`,
    );
}

async function resolveSymbolicAddress(mcp: Client, spec: string): Promise<bigint> {
    const normalized = normalizeAddressSpec(spec);
    const code = `
local a = getAddressSafe(${JSON.stringify(normalized)})
if not a then
  local s = ${JSON.stringify(normalized)}
  if not s:match('^%s*"') then
    local mod, op, off = s:match("^%s*(.-)%s*([+-])%s*(0?[xX]?%x+)%s*$")
    if mod and op and off and mod:find("%s") then
      mod = mod:gsub('^"+', ""):gsub('"+$', "")
      a = getAddressSafe(string.format('"%s"%s%s', mod, op, off))
    end
  end
end
if not a then error("bad address: " .. ${JSON.stringify(normalized)}) end
return string.format("0x%X", a)
`;
    const evalResult = await callTool(mcp, CeTool.EvalLua, { code });
    const text = extractEvalLuaText(evalResult).trim();
    try {
        return parseMonitorAddress(text);
    } catch {
        throw new Error(
            `Could not resolve address ${JSON.stringify(normalized)}: ${text}`,
        );
    }
}

async function loadMonitorWritesLua(): Promise<string> {
    return readFile(MONITOR_WRITES_LUA_URL, "utf8");
}

/**
 * Build the full Lua chunk: editable script body + one monitorWrites(...) call.
 * Address is passed as a decimal integer literal so Lua receives an exact number.
 */
export function buildMonitorWritesEvalCode(
    luaSource: string,
    address: bigint,
    size: number,
    durationMs: number,
    type: CeScanType,
): string {
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(`Invalid size: ${size}`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error(`Invalid durationMs: ${durationMs}`);
    }

    return `${luaSource}

return monitorWrites(${address.toString(10)}, ${size}, ${durationMs}, ${JSON.stringify(type)})
`;
}

/**
 * Custom MCP-facing operation: find what writes to `address`.
 * Does not call a native CE "monitor_writes" tool — it loads Lua and runs ce_eval_lua.
 */
export async function monitorWrites(
    mcp: Client,
    args: MonitorWritesArgs,
): Promise<WriteDump> {
    let address: bigint;
    if (typeof args.address === "string" && isSymbolicAddressSpec(args.address)) {
        address = await resolveSymbolicAddress(mcp, args.address);
    } else {
        address = parseMonitorAddress(args.address);
    }
    const { type, size } = resolveMonitorWritesTypeAndSize(args);
    const durationMs = args.durationMs ?? DEFAULT_DURATION_MS;

    const luaSource = await loadMonitorWritesLua();
    const code = buildMonitorWritesEvalCode(luaSource, address, size, durationMs, type);

    const evalResult = await callTool(mcp, CeTool.EvalLua, { code });
    const jsonText = extractEvalLuaText(evalResult);
    return WriteDumpSchema.parse(JSON.parse(jsonText)) as WriteDump;
}
