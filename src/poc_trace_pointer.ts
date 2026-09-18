// This script will start the Not a Hero game (if not already running) and start
// the point tracer POC TS script. This will open a Node JS REPL that allows
// for providing console input to 1. cancel 2. enter new value (typed scan) and search
// 3. choose from search results and view related assembler and select for "monitor" breakpoint
// 4. consistently dump monitored breakpoint stats 5. choose from breakpoints to begin monitoring now
// 6. provide dump of monitored breakpoint stats to user for review 7. repeat until user has found base address and add to "base_addresses.json"
//
// Architecture: Node REPL owns the human control loop; MCP client talks to Cheat Engine;
// optional Codex/LLM is only for reasoning prompts (not the scan filter loop).
// MCP call type safety: specs/SPEC_MCP_CALL_TYPE_SAFETY.md

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    CE_SCAN_TYPES,
    CeTool,
    REQUIRED_CE_TOOLS,
    callTool,
    resolveCeScanType,
    type CeScanType,
    type WriteDump,
} from "./mcp/ce_tools.ts";
import { monitorWrites, resolveMonitorWritesTypeAndSize } from "./handlers/monitor_writes.ts";
import { clearAllWriteBreakpoints } from "./handlers/write_breakpoint.ts";

const execFileAsync = promisify(execFile);

const BASE_ADDRESSES_PATH = "base_addresses.json";

type BaseAddressEntry = {
    base: string;
    note: string;
    savedAt: string;
    /**
     * CE-style pointer path. All but last: add offset then read pointer.
     * Last: add offset to get the value address (no deref).
     * Example ammo: [0, 0, 0x14, 0x100] → *(*(*base)+0x14)+0x100
     */
    offsets?: number[];
    /** Value type at the resolved address. */
    type?: CeScanType;
};

/**
 * Connect to the Cheat Engine MCP server (same server Codex would use via config.toml).
 * FIXME: replace command/args with the exact CE MCP launch command from your Codex/Cursor mcp config.
 */
async function connectCeMcp(): Promise<Client> {
    const transport = new StdioClientTransport({
        // FIXME: command + args for cheat-engine-mcp / mcp-cheat-engine bridge
        command: "npm",
        args: ["run", "mcp:start"],
    });

    const client = new Client({ name: "poc-trace-pointer", version: "0.1.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const available = new Set(tools.map((t) => t.name));
    const missing = REQUIRED_CE_TOOLS.filter((name) => !available.has(name));
    if (missing.length > 0) {
        throw new Error(
            `CE MCP missing required tools: ${missing.join(", ")}. Available: ${[...available].join(", ") || "(none)"}`,
        );
    }
    return client;
}

/**
 * Optional reasoning helper. Prefer passing tool results into the prompt;
 * do not put the scan filter loop inside Codex.
 * FIXME: decide codex exec flags / JSON parsing once you pick an LLM path.
 */
async function askCodex(prompt: string): Promise<string> {
    const { stdout } = await execFileAsync("codex", ["exec", prompt], {
        maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
}

async function loadBaseAddresses(): Promise<BaseAddressEntry[]> {
    try {
        const raw = await readFile(BASE_ADDRESSES_PATH, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error(`${BASE_ADDRESSES_PATH} must be a JSON array`);
        }
        return parsed as BaseAddressEntry[];
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw err;
    }
}

async function appendBaseAddress(entry: BaseAddressEntry): Promise<void> {
    const entries = await loadBaseAddresses();
    entries.push(entry);
    await writeFile(BASE_ADDRESSES_PATH, JSON.stringify(entries, null, 2));
}

function formatHexAddr(n: number): string {
    if (!Number.isFinite(n) || n < 0) {
        return String(n);
    }
    return `0x${Math.trunc(n).toString(16).toUpperCase()}`;
}

function parsePointerRead(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value >>> 0; // force uint32 for 32-bit game pointers
    }
    if (typeof value === "string") {
        const t = value.trim();
        if (/^0x[0-9a-fA-F]+$/i.test(t)) {
            return Number.parseInt(t, 16) >>> 0;
        }
        if (/^[0-9a-fA-F]+$/i.test(t) && /[A-Fa-f]/.test(t)) {
            return Number.parseInt(t, 16) >>> 0;
        }
        if (/^\d+$/.test(t)) {
            return Number.parseInt(t, 10) >>> 0;
        }
    }
    throw new Error(`Not a pointer value: ${JSON.stringify(value)}`);
}

/**
 * Resolve CE-style offsets: for each offset except the last, addr = readPtr(addr+off);
 * final value address = addr + lastOff.
 * Runs entirely inside CE Lua (readBytes fallback) so nil reads surface as real errors.
 */
async function resolveBasePath(
    mcp: Client,
    entry: BaseAddressEntry,
): Promise<{ steps: string[]; valueAddress: string }> {
    const offsets = entry.offsets;
    if (!offsets || offsets.length === 0) {
        throw new Error(
            `Base ${entry.base} has no offsets[] — cannot resolve (refusing to patch the static pointer itself)`,
        );
    }

    const baseNum = parsePointerRead(normalizeAddressSpec(entry.base));
    const offsetsLit = offsets.join(",");
    const code = `
local function read_u32(addr)
  if type(readInteger) == "function" then
    local ok, v = pcall(readInteger, addr)
    if ok and type(v) == "number" then
      if v < 0 then v = v + 0x100000000 end
      return v % 0x100000000
    end
  end
  if type(readBytes) == "function" then
    local ok, b = pcall(readBytes, addr, 4, true)
    if ok and type(b) == "table" and #b >= 4 then
      return (b[1] + b[2]*256 + b[3]*65536 + b[4]*16777216) % 0x100000000
    end
  end
  return nil
end

local base = ${baseNum}
local offsets = {${offsetsLit}}
local addr = base
local steps = { string.format("base 0x%X", base) }
for i = 1, #offsets - 1 do
  local off = offsets[i]
  local at = (addr + off) % 0x100000000
  local next = read_u32(at)
  if next == nil then
    error(string.format("nil u32 read at 0x%X (step %d; process attached / alive?)", at, i - 1))
  end
  steps[#steps+1] = string.format("[0x%X+0x%X] -> 0x%X", addr, off, next)
  if next == 0 then
    error("null pointer at step " .. tostring(i - 1))
  end
  addr = next
end
local last = offsets[#offsets]
local valueAddr = (addr + last) % 0x100000000
steps[#steps+1] = string.format("0x%X+0x%X -> value @ 0x%X", addr, last, valueAddr)
local parts = {}
for i = 1, #steps do
  parts[#parts+1] = string.format("%q", steps[i])
end
return string.format('{"steps":[%s],"valueAddress":"0x%X"}', table.concat(parts, ","), valueAddr)
`;

    const raw = await callTool(mcp, CeTool.EvalLua, { code });
    let text: string;
    if (typeof raw === "string") {
        text = raw;
    } else if (raw && typeof raw === "object") {
        const obj = raw as { result?: unknown; value?: unknown };
        const v = obj.result ?? obj.value;
        if (typeof v !== "string") {
            throw new Error(`resolve_base: unexpected eval result: ${JSON.stringify(raw)}`);
        }
        text = v;
    } else {
        throw new Error(`resolve_base: unexpected eval result: ${JSON.stringify(raw)}`);
    }

    const parsed = JSON.parse(text) as { steps: string[]; valueAddress: string };
    if (!Array.isArray(parsed.steps) || typeof parsed.valueAddress !== "string") {
        throw new Error(`resolve_base: bad payload: ${text}`);
    }
    return parsed;
}

function findBaseEntry(
    entries: BaseAddressEntry[],
    spec: string,
): BaseAddressEntry | undefined {
    const trimmed = spec.trim();
    if (/^\d+$/.test(trimmed)) {
        return entries[Number.parseInt(trimmed, 10)];
    }
    const want = normalizeHexAddr(normalizeAddressSpec(trimmed));
    return entries.find((e) => normalizeHexAddr(normalizeAddressSpec(e.base)) === want);
}

/**
 * Normalize a CE address spec for Lua getAddress / breakpoints.
 * Bare hex like `0C505970` / `25C3260C038` → `0x...`; leave `0x...`, decimal, and `module+offset` alone.
 */
function normalizeAddressSpec(spec: string): string {
    const s = spec.trim();
    if (/^0x[0-9A-Fa-f]+$/i.test(s)) {
        return s;
    }
    // CE-style bare hex (has A–F, or long enough to be an address not a small decimal)
    if (/^[0-9A-Fa-f]+$/i.test(s) && (/[A-Fa-f]/.test(s) || s.length >= 8)) {
        return `0x${s}`;
    }
    return s;
}

const INTEGER_SCAN_TYPES = new Set<CeScanType>([
    "byte",
    "int8",
    "uint8",
    "int16",
    "int32",
    "int",
    "int64",
]);
const FLOAT_SCAN_TYPES = new Set<CeScanType>(["float", "double"]);

function parseScanValue(
    type: CeScanType,
    raw: string,
): { value: string | number; hex: boolean } {
    const trimmed = raw.trim();
    if (type === "string" || type === "wstring") {
        if (
            (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
        ) {
            return { value: trimmed.slice(1, -1), hex: false };
        }
        return { value: trimmed, hex: false };
    }

    const hexMatch = /^0x([0-9a-fA-F]+)$/i.exec(trimmed);
    if (hexMatch && INTEGER_SCAN_TYPES.has(type)) {
        return { value: hexMatch[1]!, hex: true };
    }

    // Bare hex from CE dumps (e.g. 1BE4A908 / 0C505870) — same heuristic as monitor addresses.
    if (
        INTEGER_SCAN_TYPES.has(type) &&
        /^[0-9A-Fa-f]+$/i.test(trimmed) &&
        (/[A-Fa-f]/.test(trimmed) || trimmed.length >= 8)
    ) {
        return { value: trimmed, hex: true };
    }

    if (INTEGER_SCAN_TYPES.has(type)) {
        if (!/^-?\d+$/.test(trimmed)) {
            throw new Error(`Expected integer value for type ${type}, got ${JSON.stringify(trimmed)}`);
        }
        const n = Number(trimmed);
        return {
            value: Number.isSafeInteger(n) ? n : trimmed,
            hex: false,
        };
    }

    if (FLOAT_SCAN_TYPES.has(type)) {
        const n = Number(trimmed);
        if (!Number.isFinite(n)) {
            throw new Error(`Expected float value for type ${type}, got ${JSON.stringify(trimmed)}`);
        }
        return { value: n, hex: false };
    }

    return { value: trimmed, hex: false };
}

function parseScanCommand(
    cmd: string,
): { type: CeScanType; value: string | number; hex: boolean } | { error: string } | null {
    const match = /^scan(?:\s+(\S+)(?:\s+(.+))?)?$/i.exec(cmd);
    if (!match) {
        return null;
    }

    const typeRaw = match[1];
    const valueRaw = match[2];
    if (!typeRaw || valueRaw === undefined || valueRaw.trim() === "") {
        return {
            error: `Usage: scan <type> <value>\n  types: ${CE_SCAN_TYPES.join(", ")}\n  aliases: word, dword, qword, single, 2byte, 4byte, 8byte`,
        };
    }

    const type = resolveCeScanType(typeRaw);
    if (!type) {
        return {
            error: `Unknown scan type: ${typeRaw}. Types: ${CE_SCAN_TYPES.join(", ")}`,
        };
    }

    try {
        const parsed = parseScanValue(type, valueRaw);
        return { type, ...parsed };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}

function printHelp(): void {
    console.log(`Commands:
  scan <type> <value>             ce_scan_first (or next filter after first scan)
                                  types: ${CE_SCAN_TYPES.join(", ")}
                                  integers: decimal, 0xHEX, or bare hex (1BE4A908)
  scan_results [limit=50]         ce_scan_results — list addresses from current scan
  reset_scan                      ce_scan_reset + clear local scan state
  monitor_writes <addr> [type|size] [ms]  timed write-watch collect via ce_eval_lua
                                  example: monitor_writes 0C505970 double 5000
                                  default type: last scan type (else int32), ms=3000
  show_write_locations            same as monitor_writes using current watched address
  disassemble <loc|hex> [ctx=5]   disassemble target with ctx lines above and below
                                  tip: use a rip from monitor_writes, not the data address
  poc_patch <addr> <value> [type] write memory via ce_write_memory (raw address — NOT a static base)
                                  example: poc_patch 0C505970 99 double
  poc_patch_base <idx|addr> <value> [type] resolve offsets[] then write (safe for saved bases)
                                  example: poc_patch_base 0 99
                                  example: poc_patch_base 0x989B48 99 double
  resolve_base <idx|addr>         print pointer-chain resolution for a saved base
  list_bases                      print base_addresses.json for debugging
  save_base_address <loc|hex> <note...>  append to base_addresses.json and exit
  help                            show this help
  quit | exit | cancel            exit without saving`);
}

type DisassembleInstruction = {
    address?: string;
    bytes?: string;
    opcode?: string;
    comment?: string;
    raw?: string;
    absolute?: string;
    target?: boolean;
};

/** Normalize CE address strings to comparable hex (no 0x / leading zeros). */
function normalizeHexAddr(raw: string | undefined): string | null {
    if (!raw) return null;
    const t = raw.trim();
    if (!t) return null;
    const plus = /\+([0-9a-fA-F]+)\s*$/i.exec(t);
    if (plus) {
        return (plus[1]!.replace(/^0+/i, "") || "0").toUpperCase();
    }
    const plain = /^(?:0x)?([0-9a-fA-F]+)$/i.exec(t);
    if (plain) {
        return (plain[1]!.replace(/^0+/i, "") || "0").toUpperCase();
    }
    const trailing = /([0-9a-fA-F]{4,})\s*$/i.exec(t);
    if (trailing) {
        return (trailing[1]!.replace(/^0+/i, "") || "0").toUpperCase();
    }
    return null;
}

function extractDisassembleTargetHex(result: unknown): string | null {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
        return null;
    }
    const obj = result as { target?: unknown };
    if (typeof obj.target === "string" || typeof obj.target === "number") {
        return normalizeHexAddr(String(obj.target));
    }
    return null;
}

function isTargetInstruction(
    ins: DisassembleInstruction,
    targetHex: string | null,
): boolean {
    if (ins.target === true) return true;
    if (!targetHex) return false;
    for (const field of [ins.absolute, ins.address, ins.comment]) {
        const got = normalizeHexAddr(field);
        if (got !== null && got === targetHex) return true;
    }
    return false;
}

/** Print ce_disassemble results as aligned address / bytes / opcode lines. */
function printDisassembly(result: unknown): void {
    const instructions = extractDisassembleInstructions(result);
    if (instructions.length === 0) {
        console.log("(no instructions)");
        return;
    }

    const targetHex = extractDisassembleTargetHex(result);
    const rows = instructions.map((ins) => ({
        address: String(ins.address ?? "").trim(),
        bytes: String(ins.bytes ?? "").trim(),
        opcode: String(ins.opcode ?? "").trim(),
        target: isTargetInstruction(ins, targetHex),
    }));

    const addrWidth = Math.max(8, ...rows.map((r) => r.address.length));
    const bytesWidth = Math.max(8, ...rows.map((r) => r.bytes.length));

    for (const row of rows) {
        const mark = row.target ? "  <-- target address" : "";
        console.log(
            `${row.address.padEnd(addrWidth)}  ${row.bytes.padEnd(bytesWidth)}  ${row.opcode}${mark}`,
        );
    }
}

/** Print monitor_writes dump: JSON without nested disasm, then formatted disasm per RIP. */
function printWriteDump(dump: WriteDump): void {
    const writesWithoutDisasm = dump.writes.map(({ disasm: _disasm, ...rest }) => rest);
    console.log(
        JSON.stringify(
            {
                watched_address: dump.watched_address,
                type: dump.type,
                size: dump.size,
                writes: writesWithoutDisasm,
            },
            null,
            2,
        ),
    );

    for (const hit of dump.writes) {
        if (!hit.disasm || hit.disasm.length === 0) continue;
        console.log(`\n--- disasm ${hit.location} (rip=${hit.rip}, count=${hit.count}) ---`);
        printDisassembly({ instructions: hit.disasm });
    }
}

function extractDisassembleInstructions(result: unknown): DisassembleInstruction[] {
    if (Array.isArray(result)) {
        return result as DisassembleInstruction[];
    }
    if (result !== null && typeof result === "object") {
        const obj = result as { instructions?: unknown };
        if (Array.isArray(obj.instructions)) {
            return obj.instructions as DisassembleInstruction[];
        }
    }
    return [];
}

/**
 * Parse `monitor_writes [addr] [type|size] [durationMs]` or `show_write_locations`.
 * Examples: `monitor_writes 0C505970 double 5000`, `monitor_writes` (uses watched).
 * Returns null after printing usage errors.
 */
function parseMonitorWritesCommand(
    cmd: string,
    watched: string | undefined,
    defaultType: CeScanType | undefined,
): { address: string; type: CeScanType; size: number; durationMs: number } | null {
    const usage =
        "Usage: monitor_writes <addr> [type|size=int32] [durationMs=3000]\n" +
        "  example: monitor_writes 0C505970 double 5000";

    if (cmd === "show_write_locations" || cmd === "monitor_writes") {
        if (!watched) {
            console.error(
                cmd === "show_write_locations"
                    ? "No watched address yet. Run monitor_writes <addr> first."
                    : usage,
            );
            return null;
        }
        const resolved = resolveMonitorWritesTypeAndSize({ type: defaultType });
        return { address: watched, ...resolved, durationMs: 3000 };
    }

    const parts = cmd.slice("monitor_writes ".length).trim().split(/\s+/);
    const rawAddress = parts[0];
    if (!rawAddress) {
        console.error(usage);
        return null;
    }

    let type = defaultType;
    let size: number | undefined;
    if (parts[1] !== undefined) {
        const asType = resolveCeScanType(parts[1]);
        if (asType) {
            type = asType;
        } else {
            size = Number(parts[1]);
            if (!Number.isInteger(size) || size <= 0) {
                console.error(`Invalid type or size: ${parts[1]}`);
                console.error(`  types: ${CE_SCAN_TYPES.join(", ")}`);
                return null;
            }
        }
    }

    const durationMs = parts[2] !== undefined ? Number(parts[2]) : 3000;
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        console.error(`Invalid durationMs: ${parts[2]}`);
        return null;
    }

    if (parts[3] !== undefined) {
        console.error(usage);
        return null;
    }

    const resolved = resolveMonitorWritesTypeAndSize({ type, size });
    return {
        address: normalizeAddressSpec(rawAddress),
        ...resolved,
        durationMs,
    };
}

function parseFollowAddressCommand(
    cmd: string,
    defaultType: CeScanType | undefined,
): { target: string; type: CeScanType } | { error: string } | null {
    if (cmd !== "follow_address" && !cmd.startsWith("follow_address ")) {
        return null;
    }

    const usage = `Usage: follow_address <loc|hex> [type]\n  types: ${CE_SCAN_TYPES.join(", ")}`;
    const rest = cmd === "follow_address" ? "" : cmd.slice("follow_address ".length).trim();
    const parts = rest === "" ? [] : rest.split(/\s+/);
    const rawTarget = parts[0];
    if (!rawTarget) {
        return { error: usage };
    }

    let type: CeScanType = defaultType ?? "int32";
    if (parts[1] !== undefined) {
        const resolved = resolveCeScanType(parts[1]);
        if (!resolved) {
            return { error: `Unknown type: ${parts[1]}. Types: ${CE_SCAN_TYPES.join(", ")}` };
        }
        type = resolved;
    }
    if (parts[2] !== undefined) {
        return { error: usage };
    }

    return { target: normalizeAddressSpec(rawTarget), type };
}

/**
 * Interactive scan → write-watch → follow writers → save base address loop.
 */
async function pocTraceBaseAddress(
    mcp: Client,
    rl: ReturnType<typeof createInterface>,
): Promise<void> {
    let watched: string | undefined;
    let hasScanned = false;
    let lastScanType: CeScanType | undefined;

    // Begin CE search with ce_scan_first using console input value as starting value.
    // Filter in loop calling ce_scan_next until "choose_address" is entered.
    // `for await (const line of rl)` never redraws the prompt after console.log;
    // question() writes "> " again once each command finishes.
    while (true) {
        let line: string;
        try {
            // Newline first: on Windows, question() does cursorTo(0) and can
            // overwrite the last console.log line (e.g. 10th scan hit).
            process.stdout.write("\n");
            line = await rl.question("> ");
        } catch {
            // Interface closed (Ctrl+C / shutdown)
            break;
        }
        const cmd = line.trim();
        if (!cmd) continue;

        try {
            if (cmd === "help") {
                printHelp();
                continue;
            }

            if (cmd === "quit" || cmd === "exit" || cmd === "cancel") {
                break;
            }

            if (cmd === "reset_scan") {
                await callTool(mcp, CeTool.ScanReset, {});
                hasScanned = false;
                lastScanType = undefined;
                console.log("Scan state reset; next scan <type> <value> will call ce_scan_first");
                continue;
            }

            // scan_results [limit] → ce_scan_results
            const scanResultsCmd = /^scan_results(?:\s+(\d+))?$/i.exec(cmd);
            if (scanResultsCmd) {
                if (!hasScanned) {
                    console.error("No active scan. Run scan <type> <value> first.");
                    continue;
                }
                const limit =
                    scanResultsCmd[1] !== undefined ? Number(scanResultsCmd[1]) : 50;
                if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
                    console.error("Usage: scan_results [limit=1..1000]");
                    continue;
                }
                const dump = await callTool(mcp, CeTool.ScanResults, { limit });
                const hits = dump.results;
                console.log(
                    `Scan results: total=${dump.total} returned=${hits.length}`,
                );
                console.log("  Address = Value");
                for (const hit of hits) {
                    console.log(`  ${hit.address}  =  ${hit.value}`);
                }
                continue;
            }

            // scan <type> <value> → first scan or next-scan filter
            if (cmd === "scan" || /^scan\s/i.test(cmd)) {
                const parsed = parseScanCommand(cmd);
                if (!parsed || "error" in parsed) {
                    console.error(parsed?.error ?? "Usage: scan <type> <value>");
                    continue;
                }
                if (!hasScanned || (lastScanType !== undefined && parsed.type !== lastScanType)) {
                    if (hasScanned && lastScanType !== undefined && parsed.type !== lastScanType) {
                        console.log(
                            `Scan type changed (${lastScanType} → ${parsed.type}); starting new ce_scan_first`,
                        );
                        await callTool(mcp, CeTool.ScanReset, {});
                        hasScanned = false;
                        lastScanType = undefined;
                    }
                    const first = await callTool(mcp, CeTool.ScanFirst, {
                        value: parsed.value,
                        type: parsed.type,
                        scanOption: "exact",
                        hex: parsed.hex,
                    });
                    hasScanned = true;
                    lastScanType = parsed.type;
                    console.log(`ce_scan_first type=${parsed.type}: count=${first.count}`);
                } else {
                    // ce_scan_next has no `type` — vartype is locked by the prior first scan
                    const next = await callTool(mcp, CeTool.ScanNext, {
                        value: parsed.value,
                        scanOption: "exact",
                        hex: parsed.hex,
                    });
                    console.log(`ce_scan_next: count=${next.count}`);
                }
                continue;
            }

            // choose_address <hex|module+offset> → set write watch on that location
            // if (cmd === "choose_address" || cmd.startsWith("choose_address ")) {
            //     const raw = cmd === "choose_address"
            //         ? ""
            //         : cmd.slice("choose_address ".length).trim();
            //     if (!raw) {
            //         console.error("Usage: choose_address <hex|module+offset>");
            //         console.error("  examples: choose_address 25C3260C038");
            //         console.error("            choose_address 0x25C3260C038");
            //         console.error("            choose_address game.exe+1234");
            //         if (hasScanned) {
            //             const dump = await callTool(mcp, CeTool.ScanResults, { limit: 50 });
            //             console.log(
            //                 `Current scan candidates: total=${dump.total} returned=${dump.returned}`,
            //             );
            //             for (const hit of dump.results) {
            //                 console.log(`  ${hit.address}  =  ${hit.value}`);
            //             }
            //         }
            //         continue;
            //     }

            //     const chosen = normalizeAddressSpec(raw);
            //     // Do NOT plant a persistent hardware BP here — on this CE build that
            //     // freezes the game on the next write. Only arm BPs inside monitor_writes.
            //     const cleared = await clearAllWriteBreakpoints(mcp);
            //     if (cleared > 0) {
            //         console.log(`Cleared ${cleared} leftover breakpoint(s)`);
            //     }
            //     watched = chosen;
            //     console.log(
            //         `Selected ${watched} type=${lastScanType ?? "int32"}. Run monitor_writes to find writers.`,
            //     );
            //     continue;
            // }

            // // Dump the write locations for the watched address (custom ce_monitor_writes)
            if (
                cmd === "show_write_locations" ||
                cmd === "monitor_writes" ||
                cmd.startsWith("monitor_writes ")
            ) {
                const monitorArgs = parseMonitorWritesCommand(cmd, watched, lastScanType);
                if (!monitorArgs) {
                    continue;
                }
                watched = monitorArgs.address;
                lastScanType = monitorArgs.type;
                console.log(
                    `Monitoring writes to ${monitorArgs.address} (type=${monitorArgs.type}, size=${monitorArgs.size}, ${monitorArgs.durationMs}ms)...`,
                );
                const dump: WriteDump = await monitorWrites(mcp, monitorArgs);
                printWriteDump(dump);

                // FIXME: optional — ask Codex which writer to follow next
                // const suggestion = await askCodex(`Pick one follow_address from:\n${JSON.stringify(dump)}`);
                // console.log(suggestion);
                continue;
            }

            // if (cmd === "disassemble_watched" || cmd.startsWith("disassemble_watched ")) {
            //     if (!watched) {
            //         console.error("No watched address yet. Run choose_address first.");
            //         continue;
            //     }
            //     const countArg = cmd.slice("disassemble_watched".length).trim();
            //     const count = countArg !== "" ? Number(countArg) : 15;
            //     if (!Number.isInteger(count) || count < 1 || count > 200) {
            //         console.error("Usage: disassemble_watched [count=1..200]");
            //         continue;
            //     }
            //     console.log(
            //         `Note: watched ${watched} is a data address; for code use: disassemble <rip from monitor_writes>`,
            //     );
            //     const disassemble = await callTool(mcp, CeTool.Disassemble, {
            //         address: watched,
            //         count,
            //     });
            //     console.log(disassemble);
            //     continue;
            // }

            if (cmd === "disassemble" || cmd.startsWith("disassemble ")) {
                const rest = cmd === "disassemble" ? "" : cmd.slice("disassemble ".length).trim();
                const parts = rest === "" ? [] : rest.split(/\s+/);
                const rawAddr = parts[0];
                if (!rawAddr) {
                    console.error("Usage: disassemble <loc|hex> [ctx=5]");
                    console.error("  shows ctx instructions above and below the target");
                    console.error("  example: disassemble 0x7BFA4D");
                    console.error("           disassemble 0x7BFA4D 8");
                    continue;
                }
                const ctx = parts[1] !== undefined ? Number(parts[1]) : 5;
                if (!Number.isInteger(ctx) || ctx < 0 || ctx > 100) {
                    console.error("Usage: disassemble <loc|hex> [ctx=0..100]");
                    continue;
                }
                const address = normalizeAddressSpec(rawAddr);
                const disassemble = await callTool(mcp, CeTool.Disassemble, {
                    address,
                    before: ctx,
                    after: ctx,
                });
                printDisassembly(disassemble);
                continue;
            }

            // Follow the address to the next writer
            // if (cmd === "follow_address" || cmd.startsWith("follow_address ")) {
            //     const parsed = parseFollowAddressCommand(cmd, lastScanType);
            //     if (!parsed || "error" in parsed) {
            //         console.error(parsed?.error ?? "Usage: follow_address <loc|hex> [type]");
            //         continue;
            //     }

            //     const cleared = await clearAllWriteBreakpoints(mcp);
            //     if (cleared > 0) {
            //         console.log(`Cleared ${cleared} leftover breakpoint(s)`);
            //     }
            //     watched = parsed.target;
            //     lastScanType = parsed.type;
            //     console.log(
            //         `Selected ${watched} type=${parsed.type}. Run monitor_writes to find writers.`,
            //     );
            //     continue;
            // }

            if (cmd === "list_bases" || cmd === "show_base_addresses") {
                const entries = await loadBaseAddresses();
                if (entries.length === 0) {
                    console.log(`(no entries in ${BASE_ADDRESSES_PATH})`);
                } else {
                    console.log(JSON.stringify(entries, null, 2));
                    console.log(
                        "Tip: patch ammo with poc_patch_base <idx> <value> — do not poc_patch the static base itself",
                    );
                }
                continue;
            }

            if (cmd === "resolve_base" || cmd.startsWith("resolve_base ")) {
                const spec =
                    cmd === "resolve_base" ? "" : cmd.slice("resolve_base ".length).trim();
                if (!spec) {
                    console.error("Usage: resolve_base <idx|addr>");
                    continue;
                }
                const entries = await loadBaseAddresses();
                const entry = findBaseEntry(entries, spec);
                if (!entry) {
                    console.error(`No saved base matching ${JSON.stringify(spec)}`);
                    continue;
                }
                const resolved = await resolveBasePath(mcp, entry);
                const valueType = entry.type ?? "double";
                const current = await callTool(mcp, CeTool.ReadMemory, {
                    address: resolved.valueAddress,
                    type: valueType,
                });
                console.log(resolved.steps.join("\n"));
                console.log(
                    `value @ ${resolved.valueAddress} (${valueType}) = ${JSON.stringify(current.value)}`,
                );
                continue;
            }

            if (cmd === "poc_patch_base" || cmd.startsWith("poc_patch_base ")) {
                const rest =
                    cmd === "poc_patch_base" ? "" : cmd.slice("poc_patch_base ".length).trim();
                const parts = rest === "" ? [] : rest.split(/\s+/);
                if (parts.length < 2) {
                    console.error("Usage: poc_patch_base <idx|addr> <value> [type]");
                    console.error("  example: poc_patch_base 0 99");
                    continue;
                }
                const entries = await loadBaseAddresses();
                const entry = findBaseEntry(entries, parts[0]!);
                if (!entry) {
                    console.error(`No saved base matching ${JSON.stringify(parts[0])}`);
                    continue;
                }
                const typeRaw = parts[2];
                const type =
                    (typeRaw ? resolveCeScanType(typeRaw) : undefined) ??
                    entry.type ??
                    lastScanType ??
                    "double";
                if (typeRaw && !resolveCeScanType(typeRaw)) {
                    console.error(
                        `Unknown type: ${typeRaw}. Types: ${CE_SCAN_TYPES.join(", ")}`,
                    );
                    continue;
                }

                let value: string | number = parts[1]!;
                let hex = false;
                try {
                    const parsed = parseScanValue(type, parts[1]!);
                    value = parsed.value;
                    hex = parsed.hex;
                } catch (err) {
                    console.error(err instanceof Error ? err.message : err);
                    continue;
                }
                if (hex && typeof value === "string") {
                    value = Number.parseInt(value, 16);
                    if (!Number.isFinite(value)) {
                        console.error(`Invalid hex value: ${parts[1]}`);
                        continue;
                    }
                }

                const resolved = await resolveBasePath(mcp, entry);
                console.log(resolved.steps.join("\n"));
                const written = await callTool(mcp, CeTool.WriteMemory, {
                    address: resolved.valueAddress,
                    value,
                    type,
                });
                const readBack = await callTool(mcp, CeTool.ReadMemory, {
                    address: resolved.valueAddress,
                    type,
                });
                console.log(
                    `poc_patch_base ok=${written.ok} address=${written.address} type=${type} wrote=${JSON.stringify(value)} read=${JSON.stringify(readBack.value)}`,
                );
                continue;
            }

            if (cmd === "poc_patch" || cmd.startsWith("poc_patch ")) {
                const rest = cmd === "poc_patch" ? "" : cmd.slice("poc_patch ".length).trim();
                const parts = rest === "" ? [] : rest.split(/\s+/);
                if (parts.length < 2) {
                    console.error("Usage: poc_patch <addr> <value> [type]");
                    console.error("  example: poc_patch 0C505970 99 double");
                    console.error(
                        "  To patch via a saved base pointer chain, use: poc_patch_base <idx> <value>",
                    );
                    continue;
                }
                const address = normalizeAddressSpec(parts[0]!);
                const bases = await loadBaseAddresses();
                const matchedBase = findBaseEntry(bases, parts[0]!);
                if (matchedBase) {
                    console.error(
                        `Refusing: ${address} is a saved static base (writing it corrupts a pointer). Use: poc_patch_base ${parts[0]} ${parts[1]}${parts[2] ? ` ${parts[2]}` : ""}`,
                    );
                    continue;
                }
                const valueRaw = parts[1]!;
                const typeRaw = parts[2];
                const type =
                    (typeRaw ? resolveCeScanType(typeRaw) : undefined) ??
                    lastScanType ??
                    "int32";
                if (typeRaw && !resolveCeScanType(typeRaw)) {
                    console.error(
                        `Unknown type: ${typeRaw}. Types: ${CE_SCAN_TYPES.join(", ")}`,
                    );
                    continue;
                }

                let value: string | number = valueRaw;
                let hex = false;
                try {
                    const parsed = parseScanValue(type, valueRaw);
                    value = parsed.value;
                    hex = parsed.hex;
                } catch (err) {
                    console.error(err instanceof Error ? err.message : err);
                    continue;
                }
                // ce_write_memory has no hex flag — pass a decimal/string CE understands.
                if (hex && typeof value === "string") {
                    value = Number.parseInt(value, 16);
                    if (!Number.isFinite(value)) {
                        console.error(`Invalid hex value: ${valueRaw}`);
                        continue;
                    }
                }

                const written = await callTool(mcp, CeTool.WriteMemory, {
                    address,
                    value,
                    type,
                });
                const readBack = await callTool(mcp, CeTool.ReadMemory, {
                    address,
                    type,
                });
                console.log(
                    `poc_patch ok=${written.ok} address=${written.address} type=${type} wrote=${JSON.stringify(value)} read=${JSON.stringify(readBack.value)}`,
                );
                continue;
            }

            if (cmd.startsWith("save_base_address ")) {
                const rest = cmd.slice("save_base_address ".length).trim();
                const parsed = /^(\S+)\s+(.+)$/.exec(rest);
                if (!parsed) {
                    console.error("Usage: save_base_address <loc|hex> <note...>");
                    continue;
                }
                const base = parsed[1]!;
                const note = parsed[2]!.trim();
                const entry: BaseAddressEntry = {
                    base,
                    note,
                    savedAt: new Date().toISOString(),
                };
                await appendBaseAddress(entry);
                console.log(`Appended to ${BASE_ADDRESSES_PATH}: base=${base} note=${JSON.stringify(note)}`);
                break;
            }

            console.error(`Unknown command: ${cmd} (type help)`);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
        }
    }
}

async function clearBreakpointsOnExit(mcp: Client): Promise<void> {
    try {
        const removed = await clearAllWriteBreakpoints(mcp);
        console.log(`Cleared ${removed} write breakpoint(s)`);
    } catch (err) {
        console.error("Failed to clear write breakpoints on exit:", err);
    }
}

const main = async (): Promise<void> => {
    // Connect to MCP server and validate tool list.
    // FIXME: optional — also smoke-test via Codex if you want parity with ~/.codex/config.toml
    const mcp = await connectCeMcp();
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "> ",
    });

    let cleaningUp = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (cleaningUp) return;
        cleaningUp = true;
        console.log(`\nShutting down (${reason})...`);
        rl.close();
        await clearBreakpointsOnExit(mcp);
        await mcp.close();
    };

    process.once("SIGINT", () => {
        void shutdown("Ctrl+C").then(() => {
            process.exit(0);
        });
    });

    console.log(`POC trace pointer attached to RE MCP server`);
    printHelp();

    try {
        await pocTraceBaseAddress(mcp, rl);
    } finally {
        if (!cleaningUp) {
            cleaningUp = true;
            rl.close();
            // Normal exit (quit/exit/cancel/save_base_address): clear breakpoints then close MCP
            await clearBreakpointsOnExit(mcp);
            await mcp.close();
        }
    }
};

const entryPath = process.argv[1];
const isMain =
    typeof entryPath === "string" &&
    import.meta.url === pathToFileURL(path.resolve(entryPath)).href;

if (isMain) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

export {
    main,
    pocTraceBaseAddress,
    connectCeMcp,
    askCodex,
    appendBaseAddress,
    loadBaseAddresses,
};

export { monitorWrites, resolveMonitorWritesTypeAndSize } from "./handlers/monitor_writes.ts";
export {
    followWriteAddress,
    removeWriteBreakpoint,
    setWriteBreakpoint,
    clearAllWriteBreakpoints,
} from "./handlers/write_breakpoint.ts";

export {
    CE_SCAN_TYPES,
    CeTool,
    callTool,
    parseToolResult,
    extractMcpJsonPayload,
    REQUIRED_CE_TOOLS,
    resolveCeScanType,
    ceScanTypeSize,
} from "./mcp/ce_tools.ts";
