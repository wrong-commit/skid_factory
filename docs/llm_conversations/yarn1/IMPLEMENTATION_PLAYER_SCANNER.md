# Implementation: Player Data Model Scanner → CE MCP Validation

## Goal

First vertical slice:

1. **Discover** a candidate player object / field layout in a target process.
2. **Validate** fields with CE MCP **read/write experiments**.
3. **Emit** a durable `PlayerModel` the agent can reuse.

This implements the “autonomous memory discovery + closed-loop hypothesis testing” gap from `processForReasoning.md`. It does **not** specify anti-cheat bypass or online competitive abuse. Server-authoritative fields may fail write tests; record that as metadata (`authority: client|server|unknown`).

---

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ Agent (Cursor / Claude / etc.)                           │
│  - reasoning loop                                        │
│  - maintains HypothesisSet + PlayerModel draft           │
└────────────────────────────┬─────────────────────────────┘
                             │ MCP tool calls
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Logical ops adapter (our code)                           │
│  attach, scan_value, scan_next, read, write,             │
│  pointer_resolve, aob_scan, modules                      │
└────────────────────────────┬─────────────────────────────┘
                             │ bridge-specific tools
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Cheat Engine MCP bridge                                  │
└────────────────────────────┬─────────────────────────────┘
                             ▼
                      Target process
```

Keep **logical ops** stable; map them once per bridge (cheatengine-mcp-bridge, ce-mcp, …).

---

## Data model

```yaml
# schemas/player_model.schema.yaml (conceptual)
PlayerModel:
  process: string
  module: string                 # e.g. game.exe
  discovered_at: iso8601
  base:
    kind: static | pointer_chain | aob+offset
    static_rva: hex?             # when kind=static
    pointer_chain: [hex]?        # module+offsets
    aob: string?
    aob_offset: int?
  fields:
    - name: health | mana | x | y | z | ...
      offset: int                # from base
      type: i32 | f32 | f64 | ...
      confidence: 0.0-1.0
      authority: client | server | unknown
      evidence: [string]
  rejected:
    - address: hex
      reason: string
```

Hypothesis object (runtime only):

```text
Hypothesis {
  id: H1
  claim: "base B + 0x1A8 is f32 health"
  prior: 0.4
  posterior: 0.0-1.0
  tests_passed: [...]
  tests_failed: [...]
}
```

---

## Phase 0 — Preconditions

**Inputs (config / human):**

| Input | Example | Required |
| --- | --- | --- |
| Process name / PID | `MyGame.exe` | yes |
| Field priors | health ≈ 100, type f32\|i32 | yes for v1 |
| Optional position prior | x,y,z approx | strongly recommended |
| Module name | main exe | yes |
| Scan region | all / module only | default module+heap heuristics |

**Agent steps:**

1. `attach(process)`
2. `list_modules()` → pick primary module
3. Record ASLR slide / base address
4. Open an **action log** (every MCP call + result summary)

Do not proceed to writes until at least one scalar candidate exists.

---

## Phase 1 — Scalar candidate scan (scanner core)

### 1.1 Initial value scan

For each prior field `F` with expected value `V` and type set `T ∈ {i32,f32,...}`:

```text
for type in T:
  results[F,type] = scan_value(V, type, region)
```

If result count is huge (e.g. > 50k), narrow region or require a second known value.

### 1.2 Differential next-scans

Drive the game state (human or scripted cues):

| Cue | Next-scan |
| --- | --- |
| Take damage / heal | health changed / unchanged |
| Stand still | position stable |
| Move forward | position changed |
| Wait idle | filter “noise” addresses that twitch every frame |

Protocol:

```text
snapshot_labels = []
loop until candidates[F] <= N_max or rounds == R_max:
  ask_or_wait("change health" | "move" | "idle")
  scan_next(condition)   # increased | decreased | changed | unchanged
  record remaining count
```

**Output:** small address sets per field, ideally < 64 each.

### 1.3 Cross-field clustering → candidate bases

Player fields usually live in one allocation:

```text
for each address a_health in candidates[health]:
  for each a_x in candidates[x]:
    delta = a_x - a_health
    if delta in plausible_struct_span (e.g. 0 < |delta| < 0x400):
      vote for base = min(a_health, a_x, ...) aligned to 8/16
```

Ranking:

1. Most fields explained by one base
2. Offsets match common patterns (floats packed, health near max-health)
3. Stability across 2–3 seconds of idle (base pointer unchanged)

Emit top-K `CandidateBase` objects.

### 1.4 Optional pointerization

For each surviving absolute address:

```text
pointer_scan(address) → chains ending in module static
score chains by length, uniqueness, reload survival (if user reloads once)
```

Prefer a short module-relative chain over raw heap addresses for persistence.

### 1.5 Emit draft PlayerModel

Fill `base` + `fields[]` with low/medium confidence and evidence strings like:

- `value_scan matched 100 as f32`
- `decreased after damage cue`
- `co-located with xyz within 0x80`

---

## Phase 2 — Closed-loop validation (MCP reads/writes)

Writes exist to **test hypotheses**, with restore.

### 2.1 Safety protocol (mandatory)

```text
def experimental_write(addr, typ, new_value, observe_ms=500):
  old = read(addr, typ)
  write(addr, typ, new_value)
  sleep(observe_ms)
  now = read(addr, typ)
  side_effects = observe_agent_notes()   # UI HP bar, crash, rubber-band, etc.
  write(addr, typ, old)                 # restore
  sleep(observe_ms)
  restored = read(addr, typ)
  return ExperimentResult(...)
```

Rules:

- One field per experiment.
- Tiny deltas first (health `-1`, position `+0.5`).
- Abort series on crash / freeze.
- Log all writes.

### 2.2 Behavioral tests

| Field | Test | Pass signal | Fail / authority note |
| --- | --- | --- | --- |
| health | write lower | UI/local state reflects; value sticks ≥ observe_ms | snaps back → likely server/UI copy |
| max_health | write higher | clamp behavior consistent | unrelated |
| x/y/z | micro-translate | avatar moves or camera follows | instant revert → server/corrected |
| godmode candidate | freeze value | external damage doesn’t change cell | may be display-only |

Update `confidence` and `authority`:

```text
sticks after write          → confidence ↑, authority=client (or local copy)
reverts quickly             → confidence may still ↑ for "display health", authority=server
crash / nonsense            → reject hypothesis
```

### 2.3 Disambiguation

If two bases remain:

- Prefer base whose writes affect **observable** gameplay/UI.
- Prefer base stable under idle.
- Prefer pointer-chain rebind success after map reload (if available).

---

## Phase 3 — Persistence & revalidation

Save `player_model.json` (or YAML).

On next session:

1. Attach process / compute new module base.
2. Resolve `base` via pointer chain or AOB.
3. Re-read each field; compare type sanity (health in range, xyz finite).
4. If broken: re-enter Phase 1 with priors seeded from old offsets (relative layout often survives).

Optional v1.1: generate AOB near code that accesses the field (`find_writes`) once CE MCP exposes it — not required for first scanner.

---

## Agent control loop (pseudocode)

```text
state = load_or_empty_model()
hyps = []

attach()
modules = list_modules()

for field in priors:
  hyps += value_scan_hypotheses(field)

while not stopping:
  if need_narrowing:
    cue = next_cue()
    wait_for_human(cue)
    hyps = apply_next_scan(hyps, cue)

  bases = cluster(hyps)
  draft = propose_player_model(bases)

  if draft.ready_for_experiments:
    for h in top_hypotheses(draft):
      result = experimental_write(...)
      update(h, result)
      if h.posterior > ACCEPT: commit_field(draft, h)
      if h.posterior < REJECT: reject(h)

  if draft.complete_enough():
    save(draft)
    break

  if stuck(): ask_human_for_new_prior_or_cue()
```

Stopping conditions: enough fields committed, human abort, or crash budget exceeded.

---

## Logical MCP adapter API

Implement these regardless of bridge tool names:

| Logical op | Purpose |
| --- | --- |
| `attach(pid\|name)` | Open target |
| `modules()` | Bases / sizes |
| `scan_value(value, type, opts)` | First scan |
| `scan_next(condition)` | Narrow |
| `scan_reset()` | Clear CE scan state |
| `read(addr, type, count=1)` | Typed read |
| `write(addr, type, value)` | Typed write |
| `pointer_scan(addr, opts)` | Chains |
| `resolve_chain(module, offsets)` | Evaluate chain |
| `aob_scan(pattern, module?)` | Signature locate |
| `get_scan_count()` | Remaining results |

**Adapter file:** `lmmYarn/ce_mcp_adapter.md` (or `.py` later) listing exact tool name mappings for the chosen bridge.

---

## Suggested repo layout

```text
lmmYarn/
  processForReasoning.md          # research landscape (existing)
  PLAN.md                         # living thoughts / milestones
  IMPLEMENTATION_PLAYER_SCANNER.md  # this file
  config/
    target.example.yaml           # process, priors, safety limits
  schemas/
    player_model.schema.json
  agent/
    prompts/
      scanner_system.md           # agent instructions for the loop
    playbooks/
      phase1_scan.md
      phase2_validate.md
  out/
    player_model.json             # runtime artifact
    action_log.jsonl
```

---

## `target.example.yaml`

```yaml
process_name: "Game.exe"
module: "Game.exe"
safety:
  max_writes_per_session: 20
  default_observe_ms: 500
  restore_retries: 2
priors:
  - name: health
    approx: 100
    types: [f32, i32]
  - name: x
    approx: null          # fill when known
    types: [f32]
  - name: y
    types: [f32]
  - name: z
    types: [f32]
scan:
  max_results_before_narrow: 50000
  struct_span: 1024
  top_k_bases: 5
accept_confidence: 0.75
reject_confidence: 0.15
```

---

## Agent prompt sketch (`scanner_system.md`)

Use as system/developer text for the MCP agent:

```text
You are an autonomous memory-structure discovery agent.
Goal: propose and validate a PlayerModel for the attached process.

Rules:
- Prefer scans and reads; use writes only as restoring experiments.
- Keep competing hypotheses with confidence and evidence.
- Log every tool call outcome into the action log summary.
- After each phase, output: CandidateBase list, HypothesisSet, next cue for the human.
- If a write reverts, mark authority=server/unknown; do not escalate to evasion.
- Stop when accept_confidence fields cover the requested prior set or you are stuck.
```

---

## Testing plan (dev)

1. **Mock adapter:** fake memory blob with a packed player struct; run Phase 1–2 without CE.
2. **Local trainer / single-process sandbox:** known offsets; measure discovery time and false bases.
3. **Reload test:** restart target; pointer/AOB rebind must recover or fail loudly.
4. **Write restore test:** force restore path; assert memory equals snapshot.

---

## Non-goals (v1)

- Kernel drivers / DBVM
- Code injection / hooking beyond what validation needs
- Network protocol reverse engineering
- Anti-cheat bypass or “undetected online” guidance
- Full Ghidra fusion (M4)

---

## Implementation order (code)

1. Schema + example config  
2. Adapter interface + one real CE MCP mapping  
3. Phase 1 scripts/playbook (scan + cluster)  
4. Phase 2 experimental write helper  
5. Persist/load PlayerModel  
6. Agent prompt wiring in Cursor MCP  

When coding starts, keep `PLAN.md` milestones checked off as M0→M2 land.
