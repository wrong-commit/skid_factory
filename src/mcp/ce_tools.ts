/**
 * Typed Cheat Engine MCP tool catalog + Zod result parsing.
 * Design: specs/SPEC_MCP_CALL_TYPE_SAFETY.md
 * Aligned with mcp-cheat-engine (re-mcp) ce_* tools.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

/** Canonical MCP tool name strings (prefer this over TS enum). */
export const CeTool = {
    ScanFirst: "ce_scan_first",
    ScanNext: "ce_scan_next",
    ScanResults: "ce_scan_results",
    ScanReset: "ce_scan_reset",
    /** Escape hatch: run arbitrary CE Lua (used by custom ce_monitor_writes). */
    EvalLua: "ce_eval_lua",
    /** @deprecated Prefer custom handler monitorWrites → ce_eval_lua. */
    GetWriteLocations: "get_write_locations",
    Disassemble: "ce_disassemble",
} as const;

export type CeToolName = (typeof CeTool)[keyof typeof CeTool];

/**
 * Value types accepted by re-mcp `ce_scan_first` / `ce_read_memory` / `ce_write_memory`.
 * Source: mcp-cheat-engine/src/tools/ceTools.ts `valueType`.
 *
 * Lua `SCAN_TYPE_MAP` (bridge.lua) maps these onto CE `TVariableType`:
 *   byte/int8 → vtByte, int16 → vtWord, int32/int → vtDword,
 *   int64 → vtQword, float → vtSingle, double → vtDouble, string → vtString.
 * `uint8` and `wstring` are in the MCP enum but not in SCAN_TYPE_MAP (scan falls back to vtDword).
 * CE also has vtBinary / vtAll / vtGrouped / vtByteArray (aob); re-mcp does not expose those on ce_scan_first.
 */
export const CE_SCAN_TYPES = [
    "byte",
    "int8",
    "uint8",
    "int16",
    "int32",
    "int",
    "int64",
    "float",
    "double",
    "string",
    "wstring",
] as const;

export const CeScanTypeSchema = z.enum(CE_SCAN_TYPES);
export type CeScanType = z.infer<typeof CeScanTypeSchema>;

/** Cheat Engine UI names that map onto a re-mcp scan type. */
export const CE_SCAN_TYPE_ALIASES: Readonly<Record<string, CeScanType>> = {
    word: "int16",
    "2byte": "int16",
    "2bytes": "int16",
    dword: "int32",
    "4byte": "int32",
    "4bytes": "int32",
    qword: "int64",
    "8byte": "int64",
    "8bytes": "int64",
    single: "float",
};

export function resolveCeScanType(raw: string): CeScanType | undefined {
    const key = raw.trim().toLowerCase();
    if ((CE_SCAN_TYPES as readonly string[]).includes(key)) {
        return key as CeScanType;
    }
    return CE_SCAN_TYPE_ALIASES[key];
}

/** Hardware watch sizes for `debug_setBreakpoint` (1/2/4/8). */
export const CE_SCAN_TYPE_SIZES: Readonly<Record<CeScanType, number>> = {
    byte: 1,
    int8: 1,
    uint8: 1,
    int16: 2,
    int32: 4,
    int: 4,
    int64: 8,
    float: 4,
    double: 8,
    string: 4,
    wstring: 4,
};

export function ceScanTypeSize(type: CeScanType): number {
    return CE_SCAN_TYPE_SIZES[type];
}

/** Best-effort reverse map when only a byte size is known (4 → int32, not float). */
export function ceScanTypeFromSize(size: number): CeScanType | undefined {
    switch (size) {
        case 1:
            return "byte";
        case 2:
            return "int16";
        case 4:
            return "int32";
        case 8:
            return "int64";
        default:
            return undefined;
    }
}

/** Args for ce_scan_first (re-mcp). Process must already be attached in CE. */
export const CeScanFirstArgsSchema = z.object({
    type: CeScanTypeSchema.default("int32"),
    scanOption: z
        .enum(["exact", "bigger", "smaller", "between", "unknown"])
        .default("exact"),
    value: z.union([z.string(), z.number()]).optional(),
    value2: z.union([z.string(), z.number()]).optional(),
    hex: z.boolean().default(false),
});

/** Args for ce_scan_next (re-mcp). Value type is fixed by the prior ce_scan_first. */
export const CeScanNextArgsSchema = z.object({
    scanOption: z
        .enum([
            "exact",
            "bigger",
            "smaller",
            "between",
            "increased",
            "decreased",
            "changed",
            "unchanged",
        ])
        .default("exact"),
    value: z.union([z.string(), z.number()]).optional(),
    value2: z.union([z.string(), z.number()]).optional(),
    hex: z.boolean().default(false),
});

/** ce_scan_first / ce_scan_next return `{ count }`. */
export const CeScanCountResultSchema = z.object({
    count: z.number().int().nonnegative(),
});

export const CeScanResultsArgsSchema = z.object({
    limit: z.number().int().min(1).max(1000).default(50),
});

/** ce_scan_results return shape from bridge.lua. */
export const CeScanHitSchema = z.object({
    address: z.string(),
    value: z.union([z.string(), z.number()]),
});

export const CeScanResultsResultSchema = z.object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    results: z.array(CeScanHitSchema),
});

export type CeScanResultsResult = z.infer<typeof CeScanResultsResultSchema>;

/** ce_scan_reset takes no args. */
export const CeScanResetArgsSchema = z.object({});

export const CeScanResetResultSchema = z.object({
    ok: z.boolean().default(true),
});

export const WriteHitSchema = z.object({
    rip: z.string(),
    ripRaw: z.string(),
    location: z.string(),
    count: z.number().int().nonnegative(),
});

export const WriteDumpSchema = z.object({
    watched_address: z.string(),
    type: CeScanTypeSchema,
    size: z.number().int().positive(),
    writes: z.array(WriteHitSchema),
});

export type WriteDump = z.infer<typeof WriteDumpSchema>;

/** FIXME: tighten against a live ce_disassemble payload. */
export const DisassembleResultSchema = z.union([
    z.object({
        address: z.string(),
        asm: z.string(),
    }),
    z.array(z.record(z.string(), z.unknown())),
    z.record(z.string(), z.unknown()),
]);

export const CeEvalLuaArgsSchema = z.object({
    code: z.string().min(1),
});

/**
 * Live `ce_eval_lua` payload from bridge.lua `eval_lua`.
 * MCP `content[].text` is JSON such as `{ "ok": true, "result": 2, "type": "number" }`.
 * `result` is a Lua number/boolean/string (tables are stringified); nil omits `result`/`type`.
 */
export const CeEvalLuaResultSchema = z.union([
    z.string(),
    z.object({
        ok: z.boolean().optional(),
        result: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        type: z.string().optional(),
        value: z.string().optional(),
        output: z.string().optional(),
    }),
]);

/**
 * Per-tool args + Zod result schema. Keys MUST match live MCP tool names.
 */
export const ceToolCatalog = {
    [CeTool.ScanFirst]: {
        args: CeScanFirstArgsSchema,
        result: CeScanCountResultSchema,
    },
    [CeTool.ScanNext]: {
        args: CeScanNextArgsSchema,
        result: CeScanCountResultSchema,
    },
    [CeTool.ScanResults]: {
        args: CeScanResultsArgsSchema,
        result: CeScanResultsResultSchema,
    },
    [CeTool.ScanReset]: {
        args: CeScanResetArgsSchema,
        result: CeScanResetResultSchema,
    },
    [CeTool.EvalLua]: {
        args: CeEvalLuaArgsSchema,
        result: CeEvalLuaResultSchema,
    },
    [CeTool.GetWriteLocations]: {
        args: z.object({ address: z.string().min(1) }),
        result: WriteDumpSchema,
    },
    [CeTool.Disassemble]: {
        args: z.object({
            address: z.union([z.string(), z.number()]),
            count: z.number().int().min(1).max(200).optional().default(15),
        }),
        result: DisassembleResultSchema,
    },
} as const;

export type CeToolCatalog = typeof ceToolCatalog;

export type CeToolMap = {
    [K in CeToolName]: {
        args: z.input<CeToolCatalog[K]["args"]>;
        result: z.infer<CeToolCatalog[K]["result"]>;
    };
};

export const REQUIRED_CE_TOOLS: readonly CeToolName[] = [
    CeTool.ScanFirst,
    CeTool.ScanNext,
    CeTool.ScanResults,
    CeTool.ScanReset,
    CeTool.EvalLua,
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
