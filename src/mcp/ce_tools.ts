/**
 * Typed Cheat Engine MCP tool catalog + Zod result parsing.
 * Design: specs/SPEC_MCP_CALL_TYPE_SAFETY.md
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

/** Canonical MCP tool name strings (prefer this over TS enum). */
export const CeTool = {
    ScanFirst: "ce_scan_first",
    ScanNext: "ce_scan_next",
    ScanReset: "ce_scan_reset",
    GetWriteLocations: "get_write_locations",
    Disassemble: "disassemble",
} as const;

export type CeToolName = (typeof CeTool)[keyof typeof CeTool];

export const CeScanTypeSchema = z.enum(["int32"]);
export type CeScanType = z.infer<typeof CeScanTypeSchema>;

export const CeScanArgsSchema = z.object({
    pid: z.number().int().positive(),
    value: z.number(),
    type: CeScanTypeSchema,
});

/** FIXME: replace with real ce_scan_* response shape from the CE MCP bridge. */
export const CeScanResultSchema = z.object({
    count: z.number().int().nonnegative(),
    addresses: z.array(z.string()).optional(),
});

/** Args for clearing an in-progress value scan for a process. */
export const CeScanResetArgsSchema = z.object({
    pid: z.number().int().positive(),
});

/** FIXME: replace with real ce_scan_reset response shape from the CE MCP bridge. */
export const CeScanResetResultSchema = z.object({
    ok: z.boolean().default(true),
});

export const WriteHitSchema = z.object({
    rip: z.string(),
    location: z.string(),
    count: z.number().int().nonnegative(),
});

export const WriteDumpSchema = z.object({
    watched_address: z.string(),
    writes: z.array(WriteHitSchema),
});

export type WriteDump = z.infer<typeof WriteDumpSchema>;

/** FIXME: replace with real disassemble response shape from the CE MCP bridge. */
export const DisassembleResultSchema = z.object({
    address: z.string(),
    asm: z.string(),
});

/**
 * Per-tool args + Zod result schema. Keys MUST match live MCP tool names.
 * FIXME: rename GetWriteLocations / Disassemble keys when the bridge's real names are known.
 */
export const ceToolCatalog = {
    [CeTool.ScanFirst]: {
        args: CeScanArgsSchema,
        result: CeScanResultSchema,
    },
    [CeTool.ScanNext]: {
        args: CeScanArgsSchema,
        result: CeScanResultSchema,
    },
    [CeTool.ScanReset]: {
        args: CeScanResetArgsSchema,
        result: CeScanResetResultSchema,
    },
    [CeTool.GetWriteLocations]: {
        args: z.object({ address: z.string().min(1) }),
        result: WriteDumpSchema,
    },
    [CeTool.Disassemble]: {
        args: z.object({ address: z.string().min(1) }),
        result: DisassembleResultSchema,
    },
} as const;

export type CeToolCatalog = typeof ceToolCatalog;

export type CeToolMap = {
    [K in CeToolName]: {
        args: z.infer<CeToolCatalog[K]["args"]>;
        result: z.infer<CeToolCatalog[K]["result"]>;
    };
};

export const REQUIRED_CE_TOOLS: readonly CeToolName[] = [
    CeTool.ScanFirst,
    CeTool.ScanNext,
    CeTool.ScanReset,
    CeTool.GetWriteLocations,
    CeTool.Disassemble,
];

/**
 * Pull a JSON-ish payload out of an MCP CallToolResult.
 * FIXME: harden for multi-block content, resource links, and structuredContent.
 */
export function extractMcpJsonPayload(raw: unknown): unknown {
    if (raw === null || typeof raw !== "object") {
        throw new Error("MCP tool result is not an object");
    }

    const result = raw as {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
    };

    if (result.isError) {
        throw new Error(`MCP tool returned isError=true: ${JSON.stringify(raw)}`);
    }

    if (result.structuredContent !== undefined) {
        return result.structuredContent;
    }

    const textBlocks = (result.content ?? []).filter(
        (b) => b.type === "text" && typeof b.text === "string",
    );
    if (textBlocks.length === 0) {
        throw new Error(`MCP tool result has no text/structured content: ${JSON.stringify(raw)}`);
    }

    const text = textBlocks.map((b) => b.text).join("\n");
    try {
        return JSON.parse(text) as unknown;
    } catch {
        // Some tools may return plain text; leave as string for schema to accept or reject.
        return text;
    }
}

export function parseToolResult<N extends CeToolName>(
    name: N,
    raw: unknown,
): CeToolMap[N]["result"] {
    const payload = extractMcpJsonPayload(raw);
    return ceToolCatalog[name].result.parse(payload) as CeToolMap[N]["result"];
}

export async function callTool<N extends CeToolName>(
    client: Client,
    name: N,
    args: CeToolMap[N]["args"],
): Promise<CeToolMap[N]["result"]> {
    const parsedArgs = ceToolCatalog[name].args.parse(args);
    const raw = await client.callTool({
        name,
        arguments: parsedArgs as Record<string, unknown>,
    });
    console.log(`MCP RESULT DEBUG (${name}):\n${JSON.stringify(raw, undefined, 2)}`);
    return parseToolResult(name, raw);
}
