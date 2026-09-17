/**
 * Clear / set CE write breakpoints via MCP ce_eval_lua.
 * Lua: src/lua/remove_write_breakpoint.lua, src/lua/set_write_breakpoint.lua
 */

import { readFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CeTool, callTool } from "../mcp/ce_tools.ts";

const REMOVE_LUA_URL = new URL("../lua/remove_write_breakpoint.lua", import.meta.url);
const SET_LUA_URL = new URL("../lua/set_write_breakpoint.lua", import.meta.url);

function luaStringLiteral(value: string): string {
    return JSON.stringify(value);
}

/**
 * Remove the write breakpoint at `address` (hex, decimal, or CE `module+offset`).
 * No-ops at the CE level if nothing is registered; still succeeds if the address resolves.
 */
export async function removeWriteBreakpoint(
    mcp: Client,
    address: string,
): Promise<void> {
    const luaSource = await readFile(REMOVE_LUA_URL, "utf8");
    const code = `${luaSource}

return removeWriteBreakpoint(${luaStringLiteral(address)})
`;
    await callTool(mcp, CeTool.EvalLua, { code });
}

/**
 * Set a hardware write breakpoint on `address`. Prefer removing any previous watch first.
 */
export async function setWriteBreakpoint(
    mcp: Client,
    address: string,
    size = 4,
): Promise<string> {
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(`Invalid size: ${size}`);
    }

    const luaSource = await readFile(SET_LUA_URL, "utf8");
    const code = `${luaSource}

return setWriteBreakpoint(${luaStringLiteral(address)}, ${size})
`;
    const result = await callTool(mcp, CeTool.EvalLua, { code });
    if (typeof result === "string") {
        return result;
    }
    if (result !== null && typeof result === "object") {
        for (const key of ["result", "value", "output"] as const) {
            const v = (result as Record<string, unknown>)[key];
            if (typeof v === "string") {
                return v;
            }
        }
    }
    return address;
}

/**
 * Replace the active write watch: remove `previous` (if any), set on `target`.
 */
export async function followWriteAddress(
    mcp: Client,
    target: string,
    previous?: string,
    size = 4,
): Promise<string> {
    if (previous && previous !== target) {
        await removeWriteBreakpoint(mcp, previous);
    }
    return setWriteBreakpoint(mcp, target, size);
}
