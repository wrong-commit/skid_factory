/**
 * Custom ce_monitor_writes: run CE Lua write-watch via MCP ce_eval_lua.
 * Spec: specs/SPEC_POC_FIND_WRITE_ADDRESS.md
 * Lua source of truth: src/lua/monitor_writes.lua
 */

import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CeTool, WriteDumpSchema, callTool, type WriteDump } from "../mcp/ce_tools.ts";

const MONITOR_WRITES_LUA_URL = new URL("../lua/monitor_writes.lua", import.meta.url);

export type MonitorWritesArgs = {
    /** Data address to watch (hex `0x...` or decimal string/number). */
    address: string | number;
    /** Watch size in bytes. Default 4 (int32). */
    size?: number;
    /** How long CE collects hits before removing the breakpoint. Default 3000. */
    durationMs?: number;
};

const DEFAULT_SIZE = 4;
const DEFAULT_DURATION_MS = 3000;

/** Parse address into a Lua-safe unsigned integer literal. */
export function parseMonitorAddress(address: string | number): bigint {
    if (typeof address === "number") {
        if (!Number.isFinite(address) || address < 0) {
            throw new Error(`Invalid monitor address: ${address}`);
        }
        return BigInt(Math.trunc(address));
    }

    const trimmed = address.trim();
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
        return BigInt(trimmed);
    }
    if (/^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
    }
    throw new Error(
        `Invalid monitor address: ${JSON.stringify(address)} (expected hex 0x... or decimal)`,
    );
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
): string {
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(`Invalid size: ${size}`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error(`Invalid durationMs: ${durationMs}`);
    }

    return `${luaSource}

return monitorWrites(${address.toString(10)}, ${size}, ${durationMs})
`;
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

/**
 * Custom MCP-facing operation: find what writes to `address`.
 * Does not call a native CE "monitor_writes" tool — it loads Lua and runs ce_eval_lua.
 */
export async function monitorWrites(
    mcp: Client,
    args: MonitorWritesArgs,
): Promise<WriteDump> {
    const address = parseMonitorAddress(args.address);
    const size = args.size ?? DEFAULT_SIZE;
    const durationMs = args.durationMs ?? DEFAULT_DURATION_MS;

    const luaSource = await loadMonitorWritesLua();
    const code = buildMonitorWritesEvalCode(luaSource, address, size, durationMs);

    const evalResult = await callTool(mcp, CeTool.EvalLua, { code });
    const jsonText = extractEvalLuaText(evalResult);
    return WriteDumpSchema.parse(JSON.parse(jsonText)) as WriteDump;
}
