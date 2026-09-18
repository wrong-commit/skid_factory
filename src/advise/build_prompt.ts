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
