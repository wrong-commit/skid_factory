/**
 * One-shot Cursor Agent CLI (`agent -p --mode ask`).
 * SPEC: specs/SPEC_POC_ADVISE_CURSOR_CLI.md
 *
 * Windows installs expose `agent.cmd` → PowerShell → versioned `node.exe` + `index.js`.
 * Invoking `agent.cmd` via execFile/cmd mangles long prompts (empty reply). We resolve
 * the versioned Node entrypoint and pass the prompt on **stdin**.
 */

import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CursorOneShotOpts = {
    cwd?: string;
    timeoutMs?: number;
    cli?: string;
    model?: string;
};

async function pathExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

function parseVersionSortKey(name: string): number {
    // YYYY.MM.DD-commit or YYYY.MM.DD-HH-MM-SS-commit
    const datePart = name.split("-")[0] ?? "";
    const parts = datePart.split(".");
    if (parts.length !== 3) return 0;
    const y = parts[0] ?? "0";
    const m = (parts[1] ?? "0").padStart(2, "0");
    const d = (parts[2] ?? "0").padStart(2, "0");
    return Number.parseInt(`${y}${m}${d}`, 10) || 0;
}

/**
 * Prefer versioned cursor-agent node entrypoint so we can pipe the prompt on stdin.
 */
export async function resolveAgentEntrypoint(): Promise<{
    node: string;
    entry: string;
    label: string;
}> {
    const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
    const root = path.join(local, "cursor-agent");
    const versionsRoot = path.join(root, "versions");

    if (await pathExists(versionsRoot)) {
        const dirs = await readdir(versionsRoot, { withFileTypes: true });
        const versionDirs = dirs
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .filter((name) =>
                /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(name),
            )
            .sort((a, b) => parseVersionSortKey(b) - parseVersionSortKey(a));

        for (const name of versionDirs) {
            const node = path.join(versionsRoot, name, "node.exe");
            const entry = path.join(versionsRoot, name, "index.js");
            if ((await pathExists(node)) && (await pathExists(entry))) {
                return { node, entry, label: `cursor-agent/${name}` };
            }
        }
    }

    // Same-dir layout (older installs)
    const node = path.join(root, "node.exe");
    const entry = path.join(root, "index.js");
    if ((await pathExists(node)) && (await pathExists(entry))) {
        return { node, entry, label: "cursor-agent" };
    }

    throw new Error(
        `Could not find Cursor agent under ${versionsRoot}. ` +
            `Run 'agent' once in a terminal, or set ADVISE_NODE and ADVISE_ENTRY to node.exe and index.js.`,
    );
}

function runSpawn(
    command: string,
    args: string[],
    opts: {
        cwd: string;
        timeoutMs: number;
        env: NodeJS.ProcessEnv;
        stdinText: string;
    },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(Object.assign(new Error("timed out"), { killed: true, stdout, stderr }));
        }, opts.timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
        });

        child.stdin.write(opts.stdinText, "utf8");
        child.stdin.end();
    });
}

export async function runCursorOneShot(
    prompt: string,
    opts: CursorOneShotOpts = {},
): Promise<string> {
    const timeoutMs =
        opts.timeoutMs ??
        (Number(process.env.ADVISE_TIMEOUT_MS) || 180_000);
    const model = opts.model ?? process.env.ADVISE_MODEL;
    const cwd = opts.cwd ?? process.cwd();

    const overrideNode = process.env.ADVISE_NODE;
    const overrideEntry = process.env.ADVISE_ENTRY;
    const { node, entry, label } =
        overrideNode && overrideEntry
            ? { node: overrideNode, entry: overrideEntry, label: "ADVISE_NODE/ENTRY" }
            : await resolveAgentEntrypoint();

    const args = [entry, "-p", "--mode", "ask", "--output-format", "text"];
    if (model) {
        args.push("--model", model);
    }

    // Prompt on stdin avoids Windows cmdline length + .cmd quoting issues.
    const stdinText = prompt.endsWith("\n") ? prompt : `${prompt}\n`;

    if (process.env.ADVISE_DEBUG === "1") {
        console.error(`[advise] entrypoint=${label}`);
        console.error(`[advise] node=${node}`);
        console.error(`[advise] promptChars=${stdinText.length}`);
    }

    try {
        const { stdout, stderr, code } = await runSpawn(node, args, {
            cwd,
            timeoutMs,
            stdinText,
            env: {
                ...process.env,
                CE_BRIDGE_PORT: "",
                X64_BRIDGE_PORT: "",
                GHIDRA_BRIDGE_PORT: "",
                // Match agent.ps1 compile cache if unset
                NODE_COMPILE_CACHE:
                    process.env.NODE_COMPILE_CACHE ??
                    path.join(
                        process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
                        "cursor-compile-cache",
                    ),
            },
        });

        const text = stdout.trim() || stderr.trim();
        if (process.env.ADVISE_DEBUG === "1") {
            console.error(`[advise] exit=${code} stdoutChars=${stdout.length} stderrChars=${stderr.length}`);
        }
        if (!text) {
            throw new Error(
                `Cursor CLI returned empty output (exit ${code}, entry ${label}). ` +
                    `Try ADVISE_DEBUG=1, or run agent manually with a short prompt.`,
            );
        }
        // Prefer stdout; if model wrote only to stderr, we already fell back.
        return stdout.trim() || text;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            killed?: boolean;
        };
        if (e.code === "ENOENT") {
            throw new Error(
                `Cursor agent node not found (${node}). Set ADVISE_NODE / ADVISE_ENTRY.`,
            );
        }
        if (e.killed) {
            throw new Error(`Cursor CLI timed out after ${timeoutMs}ms`);
        }
        const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n");
        throw new Error(`Cursor CLI failed (${label}): ${detail}`);
    }
}
