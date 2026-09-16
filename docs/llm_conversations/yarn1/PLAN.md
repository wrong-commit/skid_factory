# PLAN — Player scanner → CE MCP writes

Living notes for building the first slice of LLMGameHacker. Spec detail lives in `IMPLEMENTATION_PLAYER_SCANNER.md`; research context in `processForReasoning.md`.

Related plan: `[PLAN_PLAYER_VS_OTHERS.md](PLAN_PLAYER_VS_OTHERS.md)` — local vs other players, pointer hubs, on-demand field/structure resolve.

## What we’re building

An agent that, via Cheat Engine MCP:

1. **Finds** the local player data model (base + field offsets/types). Considers user being a element in an array of generic players
2. **Validates** by read/write experiments (snapshot → mutate → observe → restore).
3. **Persists** a `PlayerModel` so later runs rebind instead of cold-scanning.
4. **Hand off** multi-instance leftovers to the entity-map plan (local vs remote + pointer sites).

v1 success: given process + light priors (e.g. health ≈ N, rough xyz), produce a reusable model with evidence and an MCP action log.

## Why this first

Existing CE MCP bridges already expose scan/read/write/AOB. The missing piece is the **closed loop**: scan → cluster → hypothesize → experiment → score → save. That is the product; “chat controlling CE” is not.

## Current stance

- Target is **client process memory**. Online sessions may still expose useful client copies; fields that snap back get `authority: server` and stay documented, not “fixed.”
- No anti-cheat / kernel / injection work in this milestone.
- Prefer hypothesis confidence over a single brittle address.

## Decisions


| Topic             | Choice                                   | Notes                                                   |
| ----------------- | ---------------------------------------- | ------------------------------------------------------- |
| Order             | Scanner before sustained writers         | No godmode tooling until layout is scored               |
| Scan strategy     | Value + next-scan, then cluster          | AOB/pointers after candidates shrink                    |
| Writes            | Experimental + always restore            | Tiny deltas; crash budget stops the loop                |
| Bridge            | Adapter over logical ops                 | Swap CE MCP implementations without rewriting the agent |
| Output            | `player_model.json` + `action_log.jsonl` | Human-readable evidence on each field                   |
| Human in the loop | Cues only                                | “take damage”, “move”, “reload” — agent drives CE       |


## Open questions

- Which CE MCP bridge is installed in this Cursor session? Map tools before coding the adapter.
- How much automation vs manual cues for v1 (lean manual cues).
- Float vs int health and double-buffered UI copies — keep parallel hypotheses.
- Local vs other / pointer hubs → tracked in `PLAN_PLAYER_VS_OTHERS.md`.

## Milestones

- [ ] **M0** Config + schema + logical CE adapter (real or mock)
- [ ] **M1** Phase-1 scanner: attach → value/next scans → base clustering → draft model
- [ ] **M2** Phase-2 validation writes + confidence/`authority` updates
- [ ] **M3** Persist / reload / pointer-or-AOB rebind
- [ ] **M4** Agent playbooks + system prompt wired for Cursor MCP runs
- [ ] **M5** Entity map: local vs others + on-demand resolve (`PLAN_PLAYER_VS_OTHERS.md` E0–E4)
- [ ] **M6** (later) find-what-writes / Ghidra-x64dbg fusion

## Working sequence (each target)

```text
attach → modules
  → prior value scans
  → cue-driven next-scans
  → cluster co-located fields → CandidateBase[]
  → optional pointerize
  → experimental writes on top fields
  → commit PlayerModel / log failures
```

## Risks

- Result explosions on first scan → force region limits + early next-scan.
- Bad writes crash the process → hard cap writes/session; restore always.
- Patch/ASLR breaks absolutes → pointer/AOB in M3 is required for reuse.
- Display-only stats look valid on read, fail on write → expected; tag and continue.

## Immediate next

1. Confirm which CE MCP server Cursor can call; draft tool→logical-op map.
2. Add `config/target.example.yaml` + `PlayerModel` schema.
3. Run M1 playbook against one local target (mock first if bridge isn’t ready).

## Scratchpad

*Update this section as we learn from real scans.*

- _

