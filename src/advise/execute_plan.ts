/**
 * Execute allowlisted advise plan steps inside the POC.
 * SPEC: specs/SPEC_POC_ADVISE_CURSOR_CLI.md
 *
 * After evidence-producing gather steps (scan_results, list_bases, resolve_base,
 * monitor_writes), returns reAdvise=true so the host re-prompts the agent with
 * the updated transcript instead of executing a stale plan tail.
 */

import { parseDisassembleArgs, parseLeadingAddressSpec } from "../address_spec.ts";
import {
    classifyAdviseStep,
    type AdvisePlan,
    type AdviseStepKind,
} from "./parse_plan.ts";
import type { SessionLog } from "./session_log.ts";

export type AdviseRunners = {
    scanResults: (limit: number) => Promise<void>;
    disassemble: (address: string, ctx: number) => Promise<void>;
    /** Optional durationMs forces the watch window (advise uses 10s). */
    monitorWrites: (cmd: string, durationMs?: number) => Promise<void>;
    resolveBase: (spec: string) => Promise<void>;
    listBases: () => Promise<void>;
    /** Prompt user; returns trimmed answer (may be empty on bare Enter). */
    askUser: (prompt: string) => Promise<string>;
    log: SessionLog;
};

export type ExecuteAdvisePlanResult = {
    stopped: boolean;
    reason?: string;
    /**
     * Host should call advise again with the full updated transcript
     * (tool outputs + prior history).
     */
    reAdvise: boolean;
    /** Evidence kinds that triggered / were produced this run. */
    evidence: AdviseStepKind[];
    /** At least one allowlisted CE step ran. */
    ranAuto: boolean;
};

function envFlag(name: string, defaultValue: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === "") return defaultValue;
    return !/^(0|false|no|off)$/i.test(v);
}

/** Advise-run monitor_writes watch window (default 10s). */
function adviseMonitorDurationMs(): number {
    const n = Number(process.env.ADVISE_MONITOR_DURATION_MS);
    return Number.isInteger(n) && n >= 0 ? n : 10_000;
}

/** Gather steps whose dumps should drive a fresh advise turn. */
function shouldReAdviseAfter(kind: AdviseStepKind): boolean {
    if (!envFlag("ADVISE_REAADVISE_AFTER_GATHER", true)) return false;
    switch (kind) {
        case "scan_results":
        case "list_bases":
        case "resolve_base":
            return true;
        case "monitor_writes":
            return envFlag("ADVISE_REAADVISE_AFTER_MONITOR", true);
        default:
            return false;
    }
}

export async function executeAdvisePlan(
    plan: AdvisePlan,
    runners: AdviseRunners,
): Promise<ExecuteAdvisePlanResult> {
    const log = runners.log;
    const evidence: AdviseStepKind[] = [];
    let ranAuto = false;

    if (plan.steps.length === 0) {
        log.print("(advise plan has no runnable Next commands)");
        return {
            stopped: true,
            reason: "empty plan",
            reAdvise: false,
            evidence,
            ranAuto: false,
        };
    }

    log.print(`\n--- advise_run: ${plan.steps.length} step(s) ---`);

    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]!;
        const kind = classifyAdviseStep(step);
        log.print(`\n[${i + 1}/${plan.steps.length}] ${step}  (${kind})`);

        try {
            switch (kind) {
                case "scan_results": {
                    const m = /^scan_results(?:\s+(\d+))?$/i.exec(step);
                    const limit = m?.[1] !== undefined ? Number(m[1]) : 50;
                    await runners.scanResults(limit);
                    ranAuto = true;
                    evidence.push(kind);
                    if (shouldReAdviseAfter(kind)) {
                        log.print(
                            "(scan_results dumped — re-advising with updated transcript.)",
                        );
                        return {
                            stopped: false,
                            reAdvise: true,
                            evidence,
                            ranAuto,
                        };
                    }
                    break;
                }
                case "disassemble": {
                    const rest = step.replace(/^disassemble\s+/i, "").trim();
                    const parsed = parseDisassembleArgs(rest);
                    if ("error" in parsed) {
                        log.printErr(parsed.error);
                        break;
                    }
                    await runners.disassemble(parsed.address, parsed.ctx);
                    ranAuto = true;
                    evidence.push(kind);
                    break;
                }
                case "monitor_writes": {
                    const durationMs = adviseMonitorDurationMs();
                    log.gate(`ready prompt for: ${step} (${durationMs}ms)`);
                    log.print(
                        `\nAbout to run:\n  ${step}\n  (advise watch window: ${durationMs}ms)\n\n` +
                            `Do the in-game action that CHANGES this value while the watch runs\n` +
                            `(e.g. fire weapon, take damage, spend currency).\n\n` +
                            `Press Enter when you are ready to start the watch.`,
                    );
                    await runners.askUser("");
                    log.gate("user ready — starting monitor_writes");
                    await runners.monitorWrites(step, durationMs);
                    ranAuto = true;
                    evidence.push(kind);
                    log.print(
                        "\nmonitor_writes finished (JSON dump in transcript). Continue advise loop? [Y/n]",
                    );
                    const cont = (await runners.askUser("")).trim().toLowerCase();
                    log.gate(`continue after monitor: ${cont || "Y"}`);
                    if (cont === "n" || cont === "no") {
                        return {
                            stopped: true,
                            reason: "user declined continue after monitor_writes",
                            reAdvise: false,
                            evidence,
                            ranAuto,
                        };
                    }
                    if (shouldReAdviseAfter(kind)) {
                        log.print(
                            "(Will re-advise with updated monitor_writes dump.)",
                        );
                        return {
                            stopped: false,
                            reAdvise: true,
                            evidence,
                            ranAuto,
                        };
                    }
                    break;
                }
                case "resolve_base": {
                    const rest = step.replace(/^resolve_base\s+/i, "").trim();
                    const leading = parseLeadingAddressSpec(rest);
                    const spec = leading ? leading.address : rest;
                    if (!spec) {
                        log.printErr("resolve_base: missing idx|addr");
                        break;
                    }
                    await runners.resolveBase(spec);
                    ranAuto = true;
                    evidence.push(kind);
                    if (shouldReAdviseAfter(kind)) {
                        log.print(
                            "(resolve_base dumped — re-advising with updated transcript.)",
                        );
                        return {
                            stopped: false,
                            reAdvise: true,
                            evidence,
                            ranAuto,
                        };
                    }
                    break;
                }
                case "list_bases": {
                    await runners.listBases();
                    ranAuto = true;
                    evidence.push(kind);
                    if (shouldReAdviseAfter(kind)) {
                        log.print(
                            "(bases JSON dumped — re-advising with updated transcript.)",
                        );
                        return {
                            stopped: false,
                            reAdvise: true,
                            evidence,
                            ranAuto,
                        };
                    }
                    break;
                }
                case "suggest_only":
                    log.print(`Suggested (run manually):\n  ${step}`);
                    break;
                default:
                    log.print(`Skipped (not allowlisted):\n  ${step}`);
                    break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.printErr(`advise_run step failed: ${msg}`);
            return {
                stopped: true,
                reason: msg,
                reAdvise: false,
                evidence,
                ranAuto,
            };
        }
    }

    return { stopped: false, reAdvise: false, evidence, ranAuto };
}
