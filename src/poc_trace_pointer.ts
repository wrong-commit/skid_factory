// This script will start the Not a Hero game (if not already running) and start
// the point tracer POC TS script. This will open a Node JS REPL that allows
// for providing console input to 1. cancel 2. enter new value (int32) and search
// 3. choose from search results and view related assembler and select for "monitor" breakpoint
// 4. consistently dump monitored breakpoint stats 5. choose from breakpoints to begin monitoring now
// 6. provide dump of monitored breakpoint stats to user for review 7. repeat until user has found base address and add to "base_addresses.json"
//
// Architecture: Node REPL owns the human control loop; MCP client talks to Cheat Engine;
// optional Codex/LLM is only for reasoning prompts (not the scan filter loop).

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

const BASE_ADDRESSES_PATH = "base_addresses.json";

type WriteDump = {
    watched_address: string;
    writes: Array<{
        rip: string;
        location: string;
        count: number;
    }>;
};

type BaseAddressEntry = {
    base: string;
    note: string;
    pid: number;
    savedAt: string;
};

/** Parse argv to get pid */
function parsePid(argv: string[]): number {
    const arg = argv.find((a) => a.startsWith("--pid="));
    if (!arg) {
        throw new Error('Missing required argument "--pid=XXX"');
    }
    const value = arg.slice("--pid=".length);
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Invalid --pid value: ${value}`);
    }
    return pid;
}

/**
 * Connect to the Cheat Engine MCP server (same server Codex would use via config.toml).
 * FIXME: replace command/args with the exact CE MCP launch command from your Codex/Cursor mcp config.
 */
async function connectCeMcp(): Promise<Client> {
    const transport = new StdioClientTransport({
        // FIXME: command + args for cheat-engine-mcp / mcp-cheat-engine bridge
        command: "npx",
        args: ["-y", "FIXME_CE_MCP_PACKAGE"],
    });

    const client = new Client({ name: "poc-trace-pointer", version: "0.1.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    // FIXME: assert against the real scan / watch tool names your bridge exposes
    if (!tools.some((t) => t.name === "ce_scan_first")) {
        throw new Error(
            `CE MCP connected but no ce_scan_first tool found. Tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
        );
    }
    return client;
}

async function callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
): Promise<unknown> {
    const result = await client.callTool({ name, arguments: args });
    // FIXME: parse MCP CallToolResult content (text/JSON) into typed values
    console.log(`MCP RESULT DEBUG:\n${JSON.stringify(result, undefined, 2)}`)



    return result;
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

function printHelp(): void {
    console.log(`Commands:
  scan int32 <int32>              ce_scan_first (or next filter after first scan)
  reset_scan                      restart scanning state
  choose_address                  print candidates; set write watch on chosen address
  show_write_locations            dump writers JSON for current watch
  follow_address <loc|hex>        move write watch to that instruction / address
  save_base_address <loc|hex> <note...>  append to base_addresses.json and exit
  help                            show this help
  quit | exit | cancel            exit without saving`);
}

/**
 * Interactive scan → write-watch → follow writers → save base address loop.
 */
async function pocTraceBaseAddress(
    pid: number,
    mcp: Client,
    rl: ReturnType<typeof createInterface>,
): Promise<void> {
    let watched: string | undefined;
    let hasScanned = false;

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
            hasScanned = false;
            console.log("Scan state reset; next scan int32 will call ce_scan_first");
            continue;
        }

        // scan int32 <value> → first scan or next-scan filter
        // FIXME: add scan <type> variants beyond int32
        const scanInt32 = /^scan\s+int32\s+(-?\d+)$/i.exec(cmd);
        if (scanInt32) {
            const value = Number(scanInt32[1]);
            if (!hasScanned) {
                // FIXME: map to real tool name + arg schema (pid, value, type, …)
                await callTool(mcp, "ce_scan_first", {
                    pid,
                    value,
                    type: "int32",
                });
                hasScanned = true;
            } else {
                // FIXME: map to real ce_scan_next / filter tool
                await callTool(mcp, "ce_scan_next", {
                    pid,
                    value,
                    type: "int32",
                });
            }
            continue;
        }

        if (cmd === "choose_address") {
            // FIXME: fetch + print current scan candidates from CE MCP
            // FIXME: prompt user (or parse "choose_address <hex>") to pick one
            // FIXME: add write breakpoint / watch on that address; set `watched`
            const chosen = "FIXME_CHOSEN_ADDRESS";
            watched = chosen;
            console.log(`Watching writes to ${watched}`);
            // FIXME: print breakpoint / watch details from CE response
            continue;
        }

        if (cmd === "show_write_locations") {
            if (!watched) {
                console.error("No watched address yet. Run choose_address first.");
                continue;
            }
            // FIXME: replace tool name with find_writers / get_watch_stats / equivalent
            const dump = (await callTool(mcp, "FIXME_GET_WRITE_LOCATIONS", {
                address: watched,
            })) as WriteDump;
            // Expected shape:
            // {
            //   "watched_address": "0x000001F812345678",
            //   "writes": [
            //     { "rip": "0x...", "location": "game.exe+0x1234", "count": 1832 },
            //     ...
            //   ]
            // }
            console.log(JSON.stringify(dump, null, 2));

            // FIXME: optional — ask Codex which writer to follow next
            // const suggestion = await askCodex(`Pick one follow_address from:\n${JSON.stringify(dump)}`);
            // console.log(suggestion);
            continue;
        }

        if (cmd.startsWith("follow_address ")) {
            const target = cmd.slice("follow_address ".length).trim();
            if (!target) {
                console.error("Usage: follow_address <module+offset|hex>");
                continue;
            }
            // FIXME: clear previous watch and set write breakpoint on `target`
            // Prove iteration: follow_address game.exe+0x8765 replaces the breakpoint.
            watched = target;
            console.log(`Now watching writes to ${watched}`);
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
                pid,
                savedAt: new Date().toISOString(),
            };
            await appendBaseAddress(entry);
            console.log(`Appended to ${BASE_ADDRESSES_PATH}: base=${base} note=${JSON.stringify(note)}`);
            break;
        }

        console.error(`Unknown command: ${cmd} (type help)`);
    }
}

const main = async (pid: number): Promise<void> => {
    // Connect to MCP server and validate tool list.
    // FIXME: optional — also smoke-test via Codex if you want parity with ~/.codex/config.toml
    const mcp = await connectCeMcp();
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log(`POC trace pointer attached to pid=${pid}`);
    printHelp();

    try {
        await pocTraceBaseAddress(pid, mcp, rl);
    } finally {
        rl.close();
        // FIXME: confirm Client.close() / transport dispose API for your SDK version
        await mcp.close();
    }
};

const entryPath = process.argv[1];
const isMain =
    typeof entryPath === "string" &&
    import.meta.url === pathToFileURL(path.resolve(entryPath)).href;

if (isMain) {
    main(parsePid(process.argv.slice(2))).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

export {
    main,
    pocTraceBaseAddress,
    parsePid,
    connectCeMcp,
    callTool,
    askCodex,
    appendBaseAddress,
    loadBaseAddresses,
};
