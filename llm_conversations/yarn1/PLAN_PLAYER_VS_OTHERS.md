# PLAN — Local player vs other players (on-demand structure resolve)

Companion to `PLAN.md`. After (or interleaved with) finding **one** player-shaped layout, separate **local player** from **other players/entities**, map **pointer locations** into those structures, and resolve fields **on demand** so we learn where distinct data structures live without assuming a fixed global map up front.

## Problem

Value scans return many copies of the same layout: local pawn, remote pawns, corpses, spectated actors, UI mirrors. A single `PlayerModel` is not enough.

We need:

1. A **shared layout** (field offsets/types) that applies to “a player object.”
2. **Role labels** per instance: `local` | `remote` | `unknown`.
3. **Pointer graph**: static/module roots and chains that land on local vs entity-list vs other hubs.
4. **On-demand field resolution**: only materialize/confirm fields when a task asks for them (health now, later team id, later nameplate), and record *which structure* answered.

## What “on demand” means

Do not freeze a full struct dump at discover time.

```text
request(field | role | relation)
  → pick candidate bases / lists from current graph
  → targeted read / short next-scan / pointer step
  → bind field → (structure_id, offset, type, evidence)
  → cache binding; leave unrelated fields unresolved
```

Examples:

- “Where is **my** health?” → resolve local base first, then `health` on that base.
- “Where do **other** players live?” → find list/array/hash hub; sample N remote bases; confirm same layout.
- “Team/id for entity at xyz?” → walk from entity hub on demand; don’t require team during initial HP scan.

## Outputs

```text
EntityLayout          # shared offsets/types (from PLAN.md scanner)
StructureSite         # named region of memory: LocalPlayer, EntityList, Camera, …
PointerBinding        # how to reach a StructureSite (static / chain / indexed)
Instance              # concrete base address + role + last-seen
FieldBinding          # field → (structure_id | instance_id, offset, type, confidence)
ResolveCache          # on-demand results keyed by request fingerprint
```

Persist as e.g. `entity_map.json` alongside `player_model.json`.

## Disambiguation signals (local vs other)

Use cheapest signals first; combine into a score.

| Signal | Local bias | Other / shared |
| --- | --- | --- |
| Matches human movement cues | high | low for that instance |
| Camera / view target follows | high | — |
| Unique “isLocal / possessed” flag near layout | high | flag false |
| Only one instance changes on local damage/heal | high | others stable |
| Many instances, same layout, positions spread in world | — | entity set |
| Contiguous array / pool of identical strides | — | list/hub candidate |
| Write to position affects only one avatar | confirms that instance’s role | — |

Prefer **read + cue** over writes for role labeling; use micro-writes only when reads cannot separate mirrors.

## Pointer location plan

Once ≥1 layout instance exists:

1. **Pointer-scan** local base and 1–2 remote bases → chains into main module.
2. Cluster chain tails: shared prefixes suggest **hubs** (entity manager, game state).
3. Classify hubs by fan-out:
   - chain → **single** player-shaped object → `LocalPlayer` / `PossessedPawn` site
   - chain → **pointer table / array** of player-shaped objects → `EntityList` site
4. Record stride / index recipe when list-like (`base + i*stride` or pointer[i]).
5. Rebind after reload via saved chains; drop absolute heap addrs.

Unresolved: keep as `candidate_pointer` with confidence until an on-demand resolve confirms.

## On-demand resolve protocol

```text
Resolve(request):
  1. Check ResolveCache / FieldBindings
  2. Ensure EntityLayout exists (delegate to main scanner if not)
  3. Ensure required StructureSite reachable
       - if missing: pointerize known instances → propose sites
  4. Bind role if request needs local|remote
       - score instances with cues above
  5. Read field at layout.offset; optional short differential confirm
  6. Write FieldBinding + evidence; return typed value + path used
```

Failure modes to record explicitly: `no_local_unique`, `list_not_found`, `layout_mismatch`, `stale_pointer`.

## Milestones

Depends on `PLAN.md` M1 layout draft at minimum.

- [ ] **E0** Schema: StructureSite, PointerBinding, Instance, FieldBinding, ResolveCache
- [ ] **E1** Multi-instance harvest: from scan leftovers, group by layout signature (offset fingerprint)
- [ ] **E2** Role scorer: local vs remote using cue set (movement / camera / uniqueness)
- [ ] **E3** Pointerization pass → propose LocalPlayer + EntityList sites
- [ ] **E4** `Resolve(field, role?)` API used by agent instead of raw addresses
- [ ] **E5** Persist `entity_map.json`; rebind hubs after restart
- [ ] **E6** (later) richer structures on demand (inventory, team, name) reusing same hubs

## Working sequence

```text
shared layout (PLAN.md)
  → collect N instances with same layout signature
  → score local vs remote
  → pointer-scan locals + remotes → StructureSites
  → on each agent need:
        Resolve(…) → FieldBinding
  → save entity_map (sites + pointers + bindings only where resolved)
```

## Decisions

| Topic | Choice |
| --- | --- |
| When to run | After first layout draft; refine in parallel with M2 writes |
| Full struct dump | No — resolve fields on demand |
| Local definition | Highest role score under current cues, not “first scan hit” |
| Other players | Instances with same layout, non-local role, usually under EntityList |
| Agent interface | Ask for `local.health` / `remote[i].xyz`, never raw CE addresses in prompts long-term |

## Risks

- UI/display copies share values but not entity list → role scorer must punish “no world position” or “not under list hub.”
- Spectate/death swaps local pointer → re-resolve local on demand each session slice.
- Different struct versions (player vs bot) → layout signature mismatch; keep separate `EntityLayout` ids.
- Huge entity pools → sample and stride-detect; don’t pointer-scan every instance.

## Immediate next

1. Extend schema draft next to `PlayerModel` with StructureSite / PointerBinding.
2. Spec `Resolve` request vocabulary in implementation doc (or small `IMPLEMENTATION_ENTITY_MAP.md` when coding).
3. After first real layout hit, run E1–E2 on leftover scan addresses before discarding them.

## Scratchpad

- _
