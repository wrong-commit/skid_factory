/**
 * Execute allowlisted advise plan steps inside the POC.
 * SPEC: specs/SPEC_POC_ADVISE_CURSOR_CLI.md
 */

import { parseDisassembleArgs, parseLeadingAddressSpec } from "../address_spec.ts";
import {
    classifyAdviseStep,
    type AdvisePlan,
} from "./parse_plan.ts";
import type { SessionLog } from "./session_log.ts";

export type AdviseRunners = {
    scanResults: (limit: number) => Promise<void>;
    disassemble: (address: string, ctx: number) => Promise<void>;
    monitorWrites: (cmd: string) => Promise<void>;
    resolveBase: (spec: string) => Promise<void>;
    listBases: () => Promise<void>;
    /** Prompt user; returns trimmed answer (may be empty on bare Enter). */
    askUser: (prompt: string) => Promise<string>;
    log: SessionLog;
};

export type ExecuteAdvisePlanResult = {
    stopped: boolean;
    reason?: string;
    /** True if a monitor_writes step completed and user chose to continue. */
    reAdvise: boolean;
};

function envFlag(name: string, defaultValue: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === "") return defaultValue;
    return !/^(0|false|no|off)$/i.test(v);
}

export async function executeAdvisePlan(
    plan: AdvisePlan,
    runners: AdviseRunners,
): Promise<ExecuteAdvisePlanResult> {
    let reAdvise = false;
    const log = runners.log;

    if (plan.steps.length === 0) {
        log.print("(advise plan has no runnable Next commands)");
        return { stopped: true, reason: "empty plan", reAdvise: false };
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
                    break;
                }
                case "monitor_writes": {
                    log.gate(`ready prompt for: ${step}`);
                    log.print(
                        `\nAbout to run:\n  ${step}\n\n` +
                            `Do the in-game action that CHANGES this value while the watch runs\n` +
                            `(e.g. fire weapon, take damage, spend currency).\n\n` +
                            `Press Enter when you are ready to start the watch.`,
                    );
                    await runners.askUser("");
                    log.gate("user ready — starting monitor_writes");
                    await runners.monitorWrites(step);
                    log.print("\nmonitor_writes finished. Continue with the rest of the advise plan? [Y/n]");
                    const cont = (await runners.askUser("")).trim().toLowerCase();
                    log.gate(`continue after monitor: ${cont || "Y"}`);
                    if (cont === "n" || cont === "no") {
                        return {
                            stopped: true,
                            reason: "user declined continue after monitor_writes",
                            reAdvise: false,
                        };
                    }
                    reAdvise = envFlag("ADVISE_REAADVISE_AFTER_MONITOR", true);
                    if (reAdvise) {
                        log.print(
                            "(Will re-advise after plan with updated monitor_writes dump.)",
                        );
                        // Drop stale tail; fresh advise is better than unfinished gather steps.
                        return { stopped: false, reAdvise: true };
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
                    break;
                }
                case "list_bases": {
                    await runners.listBases();
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
            return { stopped: true, reason: msg, reAdvise: false };
        }
    }

    return { stopped: false, reAdvise };
}
