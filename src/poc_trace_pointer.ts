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
import { followWriteAddress, clearAllWriteBreakpoints } from "./handlers/write_breakpoint.ts";

const execFileAsync = promisify(execFile);

const BASE_ADDRESSES_PATH = "base_addresses.json";

type BaseAddressEntry = {
    base: string;
    note: string;
    savedAt: string;
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

/**
 * Normalize a CE address spec for Lua getAddress / breakpoints.
 * Bare hex like `25C3260C038` → `0x25C3260C038`; leave `0x...`, decimal, and `module+offset` alone.
 */
function normalizeAddressSpec(spec: string): string {
    const s = spec.trim();
    if (/^[0-9A-Fa-f]+$/i.test(s) && /[A-Fa-f]/.test(s)) {
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
  scan_results [limit=50]         ce_scan_results — list addresses from current scan
  reset_scan                      ce_scan_reset + clear local scan state
  choose_address <loc|hex>        set write watch (e.g. 25C3260C038, 0x..., or game.exe+1234)
  monitor_writes [addr] [type|size] [ms]  custom ce_monitor_writes via ce_eval_lua
                                  default: watched address, last scan type, 3000ms
  show_write_locations            same as monitor_writes using current watched address
  disassemble_watched             disassemble ASM around the watched address
  follow_address <loc|hex> [type] move write watch to that instruction / address
                                  default type: last scan type (else int32)
  save_base_address <loc|hex> <note...>  append to base_addresses.json and exit
  help                            show this help
  quit | exit | cancel            exit without saving`);
}

/**
 * Parse `monitor_writes [addr] [type|size] [durationMs]` or `show_write_locations`.
 * Returns null after printing usage errors.
 */
function parseMonitorWritesCommand(
    cmd: string,
    watched: string | undefined,
    defaultType: CeScanType | undefined,
): { address: string; type: CeScanType; size: number; durationMs: number } | null {
    const usage = "Usage: monitor_writes <addr> [type|size=int32] [durationMs=3000]";

    if (cmd === "show_write_locations" || cmd === "monitor_writes") {
        if (!watched) {
            console.error(
                cmd === "show_write_locations"
                    ? "No watched address yet. Run choose_address or monitor_writes <addr> first."
                    : usage,
            );
            return null;
        }
        const resolved = resolveMonitorWritesTypeAndSize({ type: defaultType });
        return { address: watched, ...resolved, durationMs: 3000 };
    }

    const parts = cmd.slice("monitor_writes ".length).trim().split(/\s+/);
    const address = parts[0];
    if (!address) {
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
                return null;
            }
        }
    }

    const durationMs = parts[2] !== undefined ? Number(parts[2]) : 3000;
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        console.error(`Invalid durationMs: ${parts[2]}`);
        return null;
    }

    const resolved = resolveMonitorWritesTypeAndSize({ type, size });
    return { address, ...resolved, durationMs };
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
    for await (const line of rl) {
        const cmd = line.trim();
        if (!cmd) continue;

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
            console.log(
                `Scan results: total=${dump.total} returned=${dump.returned}`,
            );
            for (const hit of dump.results) {
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
            if (!hasScanned) {
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
        if (cmd === "choose_address" || cmd.startsWith("choose_address ")) {
            const raw = cmd === "choose_address"
                ? ""
                : cmd.slice("choose_address ".length).trim();
            if (!raw) {
                console.error("Usage: choose_address <hex|module+offset>");
                console.error("  examples: choose_address 25C3260C038");
                console.error("            choose_address 0x25C3260C038");
                console.error("            choose_address game.exe+1234");
                if (hasScanned) {
                    const dump = await callTool(mcp, CeTool.ScanResults, { limit: 50 });
                    console.log(
                        `Current scan candidates: total=${dump.total} returned=${dump.returned}`,
                    );
                    for (const hit of dump.results) {
                        console.log(`  ${hit.address}  =  ${hit.value}`);
                    }
                }
                continue;
            }

            const chosen = normalizeAddressSpec(raw);
            const watchType = lastScanType ?? "int32";
            const resolved = await followWriteAddress(mcp, chosen, watched, watchType);
            watched = chosen;
            console.log(`Watching writes to ${watched} type=${watchType} (resolved ${resolved})`);
            continue;
        }

        // Dump the write locations for the watched address (custom ce_monitor_writes)
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
            console.log(
                `Monitoring writes to ${monitorArgs.address} (type=${monitorArgs.type}, size=${monitorArgs.size}, ${monitorArgs.durationMs}ms)...`,
            );
            const dump: WriteDump = await monitorWrites(mcp, monitorArgs);
            console.log(JSON.stringify(dump, null, 2));

            // FIXME: optional — ask Codex which writer to follow next
            // const suggestion = await askCodex(`Pick one follow_address from:\n${JSON.stringify(dump)}`);
            // console.log(suggestion);
            continue;
        }

        if (cmd === "disassemble_watched") {
            if (!watched) {
                console.error("No watched address yet. Run choose_address first.");
                continue;
            }
            // FIXME: confirm CeTool.Disassemble matches the live MCP tool name
            const disassemble = await callTool(mcp, CeTool.Disassemble, {
                address: watched,
            });
            console.log(disassemble);
            continue;
        }

        // Follow the address to the next writer
        if (cmd === "follow_address" || cmd.startsWith("follow_address ")) {
            const parsed = parseFollowAddressCommand(cmd, lastScanType);
            if (!parsed || "error" in parsed) {
                console.error(parsed?.error ?? "Usage: follow_address <loc|hex> [type]");
                continue;
            }

            const resolved = await followWriteAddress(mcp, parsed.target, watched, parsed.type);
            watched = parsed.target;
            lastScanType = parsed.type;
            console.log(
                `Cleared previous watch; now watching writes to ${watched} type=${parsed.type} (resolved ${resolved})`,
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
    const rl = createInterface({ input: process.stdin, output: process.stdout });

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
