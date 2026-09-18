# SPEC: Cursor CLI one-shot next-step advisor

Status: implemented (POC wiring; pin Cursor CLI flags if `agent -p --mode ask` drifts)  
Related: [`POC_demo.md`](./POC_demo.md), [`SPEC_POC_FIND_WRITE_ADDRESS.md`](./SPEC_POC_FIND_WRITE_ADDRESS.md), [`../README.md`](../README.md) (pointer-trace workflow)

## Goal

Add a POC REPL flow that:

1. Runs a **one-shot Cursor CLI agent prompt** with the **full session command history** (inputs + tool outputs).
2. Returns **concrete next REPL commands** for the pointer-trace workflow.
3. Can **automatically execute** an allowlisted subset of those commands inside the POC (which already owns CE MCP).
4. For **`monitor_writes`**, **pauses** and prompts the user to perform the required **manual in-game interaction**, then continues the remaining plan only after the user **confirms**.

This replaces ad-hoc copy/paste into chat and the unused `askCodex` stub.

## Non-goals

- Giving the Cursor CLI agent live MCP / CE tools (POC already owns CE via MCP; agent is text-in / text-out only).
- Fully unattended play (no human for actions that change game state).
- Auto-running destructive or high-impact commands without an explicit allowlist (`poc_patch`, `poc_patch_base`, `save_base_address`, arbitrary `scan` filters — see below).
- Guaranteeing correct pointer math (advisor proposes; auto-run still surfaces errors in the log).
- Streaming REPL takeover that removes readline for normal use.
- Training / fine-tuning; this is prompt + context packaging + a small plan executor.

## Motivation

Pointer tracing is a **stateful dialogue**: scan → filter → `monitor_writes` → read regs/disasm → pointer-scan up → save base → `poc_patch_base`. Next steps depend on the **latest dump**. Gathering steps like `scan_results`, `disassemble`, and `monitor_writes` are mechanical once proposed — the bottleneck is often “paste these three lines” plus knowing when to shoot/jump in-game. Auto-run + a confirm gate around `monitor_writes` keeps the human for gameplay and judgment, not for typing.

## User experience

### Advise only (proposal)

```text
> advise
# or: advise why did scan return 0?
```

1. Assemble context from the session log + POC state.
2. Invoke Cursor CLI **once**.
3. Print the reply (situation + next commands + why).
4. Return to `>` — history includes the advise exchange.

### Advise + execute plan

```text
> advise
> advise_run
# or combined: advise --run
# or: advise --run which writer should we follow?
```

1. Same as `advise` (or reuse the **last** parsed plan if `advise_run` with no new CLI call — see ABI).
2. Parse the `## Next commands` block into an ordered plan.
3. Execute allowlisted steps automatically (below).
4. On `monitor_writes …`: **do not start the watch yet** — prompt the user first.
5. After user confirms interaction is ready / done protocol (below), run `monitor_writes`, append results to the session log, then continue with any remaining plan steps.
6. Optionally (recommended default after a gated `monitor_writes`): run **another** one-shot `advise` with the updated transcript so the next pointer-scan suggestions use the fresh dump.

### Manual interaction gate (`monitor_writes`)

When the plan reaches a `monitor_writes` line:

```text
About to run:
  monitor_writes 0C505970 double 5000

Do the in-game action that CHANGES this value while the watch runs
(e.g. fire weapon, take damage, spend currency).

Press Enter when you are ready to start the watch (you will interact during the durationMs window).
>
```

Then:

1. User presses Enter → POC runs `monitor_writes` (game should already be ready; user interacts **during** the timed window).
2. After the command finishes, print a short summary and:

```text
monitor_writes finished. Continue with the rest of the advise plan? [Y/n]
```

3. On **Y** (default): execute remaining allowlisted steps and/or re-`advise` (config).
4. On **n**: stop the plan executor; return to normal REPL (log retained).

Alternative UX (acceptable): two prompts — “Enter to arm watch” and “Enter when you have finished interacting / watch ended” — but v1 prefers a single **ready** Enter because `monitor_writes` already blocks for `durationMs`.

## Architecture

```text
REPL (poc_trace_pointer)
  │  sessionLog: AdviseEvent[]
  │  state: watched, lastScanType, last dumps, bases
  ▼
buildAdvisePrompt(...) → runCursorOneShot(prompt)   ← no CE MCP in child
  ▼
parseAdvisePlan(reply) → AdvisePlan { steps: string[] }
  ▼
executeAdvisePlan(plan)   ← runs inside POC; uses existing handlers / callTool
  │
  ├─ scan_results / disassemble  → auto-run, log out
  ├─ monitor_writes              → prompt → run → confirm continue → …
  └─ other commands              → print as “suggested (not auto-run)” unless allowlisted later
```

The Cursor CLI child must **not** attach CE MCP. Execution stays in the Node REPL process.

## Auto-run allowlist

| Command | Auto-run? | Gate |
| --- | --- | --- |
| `scan_results` / `scan_results <limit>` | **Yes** | None |
| `disassemble <loc\|hex> [ctx]` | **Yes** | None |
| `monitor_writes …` / `show_write_locations` | **Yes** | **Manual interaction prompt** before start; **continue confirm** after |
| `scan`, `reset_scan` | No (v1) | Print only — wrong filter is costly; optional v2 with `advise_run --allow-scan` |
| `poc_patch`, `poc_patch_base`, `save_base_address` | No | Print only — mutating / exiting |
| `resolve_base`, `list_bases`, `help` | Optional yes | Harmless; may auto-run in v1 if present in plan |
| Unknown / malformed | No | Skip + warn |

Implementation: reuse the same parse/dispatch paths as the interactive REPL (do not fork a second command language). Prefer calling shared functions (`monitorWrites`, `callTool(Disassemble)`, etc.) rather than injecting text into readline.

## Session history (source of truth)

### Event model

Append-only log for the lifetime of the REPL process (not persisted by default):

```ts
type AdviseEvent =
  | { ts: string; kind: "cmd"; input: string }
  | { ts: string; kind: "out"; text: string }
  | { ts: string; kind: "err"; text: string }
  | { ts: string; kind: "note"; text: string }
  | { ts: string; kind: "gate"; text: string };  // interaction / continue prompts + answers
```

### What to record

| Command / action | Log |
| --- | --- |
| User line | `cmd` with raw input |
| `scan` / `scan_results` / `reset_scan` | summarized or full MCP JSON (see budget) |
| `monitor_writes` | full `WriteDump` JSON **without** nested `disasm` arrays if huge; always keep formatted disasm text |
| `disassemble` | formatted disasm text |
| `resolve_base` / `poc_patch_*` / `poc_patch` | steps + readback |
| `list_bases` / `save_base_address` | JSON |
| `advise` / `advise_run` | reply + plan + gate events + auto-run outputs |

### Context budget

1. **Always:** workflow rules, `list_bases`, `watched`, `lastScanType`.
2. **Recent window:** last *N* events (~40) or ~32–64 KB.
3. **Pin:** last `monitor_writes` dump + last `scan_results` table.
4. **Drop first:** MCP RESULT DEBUG verbosity → one-line summaries.

## Prompt contract

### System / fixed preamble (`prompts/advise_next_steps.md`)

Must include:

- Role: reverse-engineering coach for **this** POC’s REPL only.
- Full command whitelist from `printHelp`.
- Workflow summary (scan → monitor_writes → pointer-scan up → static root → save → resolve/patch).
- **Auto-run awareness:** the host may automatically execute `scan_results`, `disassemble`, and `monitor_writes` from `## Next commands`. Prefer putting gather steps first; put `monitor_writes` on its own line with a realistic `durationMs`.
- Hard rules:
  - Never suggest `poc_patch` on a saved static base.
  - Prefer concrete REPL lines (hex from the transcript only).
  - If evidence is insufficient, emit gather commands (`disassemble` / `monitor_writes` / `scan_results`) rather than guessing.
  - Assume 32-bit “Not a Hero” unless history says otherwise.

### User payload

```markdown
## Optional question
{user free text or "(none — suggest next steps)"}

## Execution mode
{ propose_only | execute_allowlist }

## POC state
watched: …
lastScanType: …
bases: {…}

## Session transcript
{formatted AdviseEvent log}
```

### Expected model output shape

```markdown
## Situation
1–3 sentences.

## Next commands
```text
disassemble 0x7BFA4D
scan_results 50
monitor_writes 0C505970 double 5000
```

## Why
Brief bullets.

## Watch outs
…
```

Parsing: extract the first fenced `text` (or `## Next commands` indented block) into `string[]` steps (one command per line; ignore blanks/comments).

## Plan executor

```ts
type AdvisePlan = {
  steps: string[];           // raw REPL lines
  sourceReply: string;       // full model text
};

async function executeAdvisePlan(
  mcp: Client,
  plan: AdvisePlan,
  ctx: PocReplContext,       // rl, watched, lastScanType, sessionLog, …
): Promise<{ stopped: boolean; reason?: string }>
```

Per step:

1. Classify via allowlist / parser.
2. If **not** auto-runnable → `console.log("Suggested (run manually): …")` and continue.
3. If `disassemble` / `scan_results` → run, mirror normal REPL printing, append log.
4. If `monitor_writes` / `show_write_locations`:
   - Emit `gate` “ready to start watch?” → wait for Enter on `rl`.
   - Run monitor; log dump.
   - Emit `gate` “continue plan?” → Y/n.
   - On n → `{ stopped: true }`.
   - On Y → continue; if `ADVISE_REAADVISE_AFTER_MONITOR=1` (default **true**), break remaining steps and call `advise` once more with updated log (fresh pointer-scan suggestions beat stale plan tail).

Failures (MCP error, parse error): log `err`, stop plan, leave REPL usable.

## Cursor CLI invocation

```bash
agent -p --mode ask "<prompt>"
# exact flags TBD — pin in implementation notes
```

Requirements: one-shot exit; **no CE MCP** in child; cwd = repo root; clear error if CLI missing/unauthenticated.

```ts
async function runCursorOneShot(prompt: string, opts?: { timeoutMs?: number }): Promise<string>
```

Large prompts → temp file / stdin if argv limits bind.

### Config

| Env / flag | Purpose | Default |
| --- | --- | --- |
| `ADVISE_CLI` | executable | `agent` |
| `ADVISE_MODEL` | model override if supported | CLI default |
| `ADVISE_TIMEOUT_MS` | hung one-shot kill | `120000` |
| `ADVISE_MAX_CHARS` | transcript budget | `48000` |
| `ADVISE_REAADVISE_AFTER_MONITOR` | after gated monitor + continue, run advise again | `true` |
| `ADVISE_AUTO_RESOLVE_LIST` | extra harmlessly auto-run cmds | `resolve_base,list_bases` |

## REPL command ABI

```text
advise [question...]           # one-shot proposal only
advise --run [question...]     # propose + execute allowlisted plan
advise_run                     # execute last parsed plan (no new CLI call)
advise_run --fresh [question]  # alias of advise --run
```

Help:

```text
advise [question]        Cursor CLI coach from session history (proposal)
advise --run [question]  propose + auto-run scan_results / disassemble / monitor_writes
advise_run               re-run last plan's allowlisted steps
                         monitor_writes: Enter when ready to interact in-game, then Y/n to continue
```

Do **not** exit the POC after advise (unlike `save_base_address`).

## Files to add / touch

| Path | Role |
| --- | --- |
| `prompts/advise_next_steps.md` | Preamble + output + auto-run contract |
| `src/advise/session_log.ts` | Events, format, budget |
| `src/advise/cursor_cli.ts` | `runCursorOneShot` |
| `src/advise/build_prompt.ts` | Prompt assembly |
| `src/advise/parse_plan.ts` | Extract `## Next commands` |
| `src/advise/execute_plan.ts` | Allowlist runner + monitor gates |
| `src/poc_trace_pointer.ts` | Logging; `advise` / `advise_run`; shared dispatch hooks; help |
| `README.md` | Advise subsection |
| This SPEC | Status → implemented when done |

## Acceptance criteria

- [ ] Session log records cmds/outs/gates for the session.
- [ ] `advise` prints a one-shot Cursor CLI reply without executing CE commands itself.
- [ ] `advise --run` / `advise_run` auto-executes `scan_results` and `disassemble` when present in the plan.
- [ ] `monitor_writes` in a plan **blocks** on an Enter prompt **before** starting the watch.
- [ ] After `monitor_writes`, user is asked **Y/n** before further plan steps / re-advise.
- [ ] Non-allowlisted suggestions are printed, not executed.
- [ ] CE MCP is not started by the Cursor CLI child.
- [ ] Missing CLI → actionable error; POC stays up.
- [ ] Manual test: plan `disassemble <rip>` → `monitor_writes <addr> double 3000` → user Enter → interact → Y → follow-up advise sees the new dump.

## Risks

| Risk | Mitigation |
| --- | --- |
| Auto-run wrong disassemble addr | Only hex/locs from model that appear in transcript (soft check / warn) |
| User not ready during monitor window | Clear prompt; tunable `durationMs` in suggested command |
| Stale steps after monitor | Default re-advise after continue |
| Argv / prompt too large | Temp file; transcript trim |
| Plan executor ≠ REPL parser drift | Share parse/dispatch helpers |
| Duplicate CE MCP | No MCP in CLI child |

## Out of scope follow-ups

- Auto-run `scan` / `reset_scan` / patches (explicit future flags).
- Persisted session logs across POC restarts.
- Agent-owned MCP tool calls (vs POC executor).
- Swapping Cursor CLI for Codex behind the same `runCursorOneShot` adapter.

## Example (illustrative)

**Transcript** has a writer RIP but no disasm yet; value address is watched.

**Advisor returns:**

```text
disassemble 0x77978A
monitor_writes 0FFD1F0 double 5000
```

**`advise --run`:**

1. Auto-runs `disassemble 0x77978A`, prints listing.
2. Prompts: ready to interact → user Enter.
3. Runs `monitor_writes …` while user changes the value in-game.
4. Prompts: continue? → Y.
5. Re-advises; new reply might be:

```text
reset_scan
scan int32 0xFFD098
scan_results 50
```

(`scan` / `reset_scan` printed for manual run in v1; `scan_results` would auto-run if the user pastes or a later allowlist includes it after they scan.)
