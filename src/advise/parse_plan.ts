/**
 * Extract ## Next commands plan from an advise reply.
 */

export type AdvisePlan = {
    steps: string[];
    sourceReply: string;
};

export function parseAdvisePlan(reply: string): AdvisePlan {
    const steps: string[] = [];

    // Prefer fenced block after "## Next commands"
    const section = /##\s*Next commands\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\r?\n*$)/i.exec(
        reply,
    );
    const body = section?.[1] ?? reply;

    const fence = /```(?:text)?\s*\r?\n([\s\S]*?)```/i.exec(body);
    const block = fence?.[1] ?? body;

    for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("#")) continue;
        if (line.startsWith("```")) continue;
        // Skip markdown bullets if the model wrapped commands that way
        const cmd = line.replace(/^[-*]\s+/, "").trim();
        if (!cmd) continue;
        // Ignore prose lines that don't look like REPL commands
        if (!/^[a-zA-Z_][\w]*(\s|$)/.test(cmd) && !/^(0x|[0-9A-Fa-f]{6,})/.test(cmd)) {
            continue;
        }
        steps.push(cmd);
    }

    return { steps, sourceReply: reply };
}

export type AdviseStepKind =
    | "scan_results"
    | "disassemble"
    | "monitor_writes"
    | "resolve_base"
    | "list_bases"
    | "suggest_only"
    | "unknown";

export function classifyAdviseStep(cmd: string): AdviseStepKind {
    const c = cmd.trim();
    if (/^scan_results(?:\s+\d+)?$/i.test(c)) return "scan_results";
    if (/^disassemble(\s|$)/i.test(c)) return "disassemble";
    if (/^monitor_writes(\s|$)/i.test(c) || c === "show_write_locations") {
        return "monitor_writes";
    }
    if (/^resolve_base(\s|$)/i.test(c)) return "resolve_base";
    if (c === "list_bases" || c === "show_base_addresses") return "list_bases";
    if (
        /^(scan|reset_scan|poc_patch|poc_patch_base|save_base_address|advise|help|quit|exit)(\s|$)/i.test(
            c,
        )
    ) {
        return "suggest_only";
    }
    return "unknown";
}
