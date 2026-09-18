/**
 * In-memory session transcript for Cursor CLI advise (SPEC_POC_ADVISE_CURSOR_CLI).
 */

export type AdviseEvent =
    | { ts: string; kind: "cmd"; input: string }
    | { ts: string; kind: "out"; text: string }
    | { ts: string; kind: "err"; text: string }
    | { ts: string; kind: "note"; text: string }
    | { ts: string; kind: "gate"; text: string };

function nowIso(): string {
    return new Date().toISOString();
}

export class SessionLog {
    private readonly events: AdviseEvent[] = [];

    cmd(input: string): void {
        this.events.push({ ts: nowIso(), kind: "cmd", input });
    }

    out(text: string): void {
        this.events.push({ ts: nowIso(), kind: "out", text });
    }

    err(text: string): void {
        this.events.push({ ts: nowIso(), kind: "err", text });
    }

    note(text: string): void {
        this.events.push({ ts: nowIso(), kind: "note", text });
    }

    gate(text: string): void {
        this.events.push({ ts: nowIso(), kind: "gate", text });
    }

    /** console.log + append out */
    print(...args: unknown[]): void {
        const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        console.log(text);
        this.out(text);
    }

    /** console.error + append err */
    printErr(...args: unknown[]): void {
        const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        console.error(text);
        this.err(text);
    }

    snapshot(): readonly AdviseEvent[] {
        return this.events;
    }

    /**
     * Format transcript for the advise prompt with a soft char budget.
     * Pins last monitor_writes-ish / scan_results outs when possible.
     */
    formatForPrompt(maxChars: number): string {
        const lines: string[] = [];
        for (const e of this.events) {
            switch (e.kind) {
                case "cmd":
                    lines.push(`> ${e.input}`);
                    break;
                case "out":
                    lines.push(trimMcpDebug(e.text));
                    break;
                case "err":
                    lines.push(`ERROR: ${e.text}`);
                    break;
                case "note":
                    lines.push(`NOTE: ${e.text}`);
                    break;
                case "gate":
                    lines.push(`GATE: ${e.text}`);
                    break;
            }
        }

        let full = lines.join("\n");
        if (full.length <= maxChars) return full;

        // Keep head timeline + tail (recent), prefer end.
        const keepTail = Math.floor(maxChars * 0.75);
        const keepHead = Math.floor(maxChars * 0.2);
        const head = full.slice(0, keepHead);
        const tail = full.slice(-keepTail);
        return `${head}\n\n… [transcript truncated for budget] …\n\n${tail}`;
    }
}

function trimMcpDebug(text: string): string {
    // Collapse noisy MCP RESULT DEBUG blocks to a one-liner when present.
    return text.replace(
        /MCP RESULT DEBUG \(([^)]+)\):\s*\{[\s\S]*?\n\}/g,
        (_m, name: string) => `MCP RESULT DEBUG (${name}): (omitted)`,
    );
}

export function createSessionLog(): SessionLog {
    return new SessionLog();
}
