import { readFile } from "node:fs/promises";
import type { SessionLog } from "./session_log.ts";

const PREAMBLE_URL = new URL("../../prompts/advise_next_steps.md", import.meta.url);

export type AdvisePromptState = {
    watched?: string;
    lastScanType?: string;
    basesJson: string;
    executionMode: "propose_only" | "execute_allowlist";
    question?: string;
};

export async function loadAdvisePreamble(): Promise<string> {
    return readFile(PREAMBLE_URL, "utf8");
}

export async function buildAdvisePrompt(
    session: SessionLog,
    state: AdvisePromptState,
): Promise<string> {
    const maxChars = Number(process.env.ADVISE_MAX_CHARS) || 48_000;
    const preamble = await loadAdvisePreamble();
    const question = state.question?.trim() || "(none — suggest next steps)";
    const transcript = session.formatForPrompt(maxChars);

    return `${preamble}

---

## Optional question
${question}

## Execution mode
${state.executionMode}

## Be helpful
At the end of each step, print out the next commands that should be run. 
This will guide the user through the debugging process.

## POC state
watched: ${state.watched ?? "(none)"}
lastScanType: ${state.lastScanType ?? "(none)"}
bases:
\`\`\`json
${state.basesJson}
\`\`\`

## Session transcript
\`\`\`text
${transcript}
\`\`\`
`;
}

/**
 * NOTE: removing this from the code caused the model to continue live memory hacking 
## Loop contract
The host may call you repeatedly. Each call includes the **full prior transcript**
(commands + tool outputs: scan_results tables, disassembly, monitor_writes JSON,
bases JSON). After auto-running gather steps that dump evidence, the host
re-prompts you — do not assume later plan lines still run. Prefer **1–3** next
commands focused on the newest dump.

 */