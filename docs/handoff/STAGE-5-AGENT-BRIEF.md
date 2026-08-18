# Agent brief — saga-mcp, stage 5: make the bookkeeping tell the truth

Continues `docs/handoff/STAGE-4-AGENT-BRIEF.md`. **Every rule from stages 2–4
still applies** — never spawn a real LLM worker, never weaken a gate, never write
to authority tables from a test handler, never report success without pasting
real test counts.

Branch `saga4`.

---

## 0. Why this stage exists

The project navigates by two release ladders:

- **K-ladder** (`docs/vision/SAGA-CORE-RENEWAL-PLAN.md`) — K0–K20, milestones
  M0–M6. This is the one being built.
- **C-ladder** (`docs/vision/CONTROLLED-CHANGE-PLANE-PLAN.md`) — C0–C13. Its own
  entry condition is M6/K20. **It is out of scope. Do not touch it.**

The next milestone is **M3 = K13**, whose allowed use is literally "Limited
production beta on the existing software factory" — i.e. the thing the operator
actually wants.

The problem: **the bookkeeping has fallen behind the code, in two independent
places.** Nobody can currently answer "which K-releases are closed?" from the
repository, and without that answer the remaining distance to M3 is unknown.

This stage does not change runtime behaviour. It makes the records match reality
and adds the ratchet that stops them drifting again.

### Evidence of the drift (verified 2026-08-18, do not re-litigate)

**Place 1 — the ADR closure registry.** ADR-080 is `closed` with
`evidenceOwner: K9`, an `evidence` array and a note "K9 closed at boundary
manifest 3878e51c … M2 achieved". Its siblings ADR-035, 038, 043, 044 — also
owned by `K8,K9` and by nobody else — are still `planned`, have **no** `evidence`
field, and carry notes from K5 and K1 or `null`. K9 recorded its closure on one
entry and never updated the rest.

The validator does not catch this. `tools/adr-closure-registry.mjs` emits 15
violation codes (REGISTRY_MISSING, ENTRY_ORPHAN, OWNERSHIP_MISSING, STATUS_MISMATCH,
…) and **none** of them expresses "every owning release is closed, therefore this
entry cannot still be `planned`". Structure is checked; consistency is not.

**Place 2 — the legacy allowlist.** `docs/architecture/legacy-allowlist.json`
already assigns every legacy category to an owning K-release:

| Category | Owning release |
|---|---|
| `epic-scoped-material-read` | K7 |
| `latest-candidate-code-refs` | K7 |
| `recency-selector-authority-persistence` | K7–K8 |
| `execution-scoped-lookup` | K6–K7, K10 |
| `escalate-vocabulary` | K15 |

Categories owned by K7/K8 are still listed although K9 is recorded closed — the
same disease. Note the consequence for scope: **legacy removal is not a separate
final stage; it is already distributed across the ladder.** Deleting a category
out of release order jumps ahead of the ladder, and
`recency-selector-authority-persistence` is authority-selector code — precisely
the program's top named risk ("Hidden dual authority").

---

## TASK 1 — record release closure as data

There is no machine-readable record of which K-releases are closed. Closure
currently lives in prose inside `notes` strings. That is why nothing can check it.

Add a `releases` block to `docs/architecture/adr-closure-registry.json`:

```
"releases": {
  "K5":  { "state": "closed",  "boundaryManifest": "<sha>", "milestone": "M1", "closedAt": "<date>" },
  "K9":  { "state": "closed",  "boundaryManifest": "3878e51c", "milestone": "M2", ... },
  "K12": { "state": "closed",  "boundaryManifest": "e90ba491", ... },
  "K13": { "state": "open",    "milestone": "M3" },
  ...
}
```

Populate it **only from evidence already written in the repository** — the
`notes` fields of closed entries, the milestone table in
`SAGA-CORE-RENEWAL-PLAN.md` §10, and commit history. Every release you list must
cite where its state came from.

**Do not infer a closure.** If the repository does not state that a release
closed, its state is `open` or `unknown`, and you say so. An invented closure is
worse than an unknown one: it makes the ladder look shorter than it is, which is
the exact failure this task exists to end.

## TASK 2 — reconcile the ADR entries against that record

For every registry entry whose `owningReleases` are **all** in state `closed`:

- if the decision is genuinely delivered → set `closureState: "closed"` and fill
  `evidence[]` from the real proof (suite names and counts, boundary manifest,
  ratchet names). Reuse the shape of ADR-024/033/034/080/081, which are correct.
- if you cannot find the proof → **leave it `planned` and add a note saying
  exactly what evidence is missing.** This is the honest and expected outcome for
  some entries. Do not manufacture evidence to make a number look better.

Produce, as part of your report, a table: release → owned ADRs → closed / still
open. That table is the answer to "where are we", and it is the deliverable that
matters most in this stage.

## TASK 3 — the consistency ratchet

Extend `tools/adr-closure-registry.mjs` with new violation codes and cover them
in `tests/architecture/adr-closure-registry.test.mjs`:

1. `RELEASE_UNKNOWN` — an entry names an owning release absent from the
   `releases` block.
2. `CLOSURE_LAGS_RELEASES` — every owning release is `closed`, the entry is
   `accepted`, but `closureState` is still `planned` **and** no note explains
   what evidence is missing. (An explained lag is legal; a silent one is not.)
3. `CLOSED_WITHOUT_EVIDENCE` — `closureState: "closed"` with an empty or absent
   `evidence[]`.

Rule 2 must permit a documented exception, or it will simply be worked around by
flipping states without proof. Make the exception *say something*: the note has
to name the missing evidence, not merely exist.

Keep the existing 15 codes and all three current tests passing.

## TASK 4 — reconcile the legacy allowlist against the code

For each of the five categories, check whether the listed files still contain the
legacy construct.

- Counts and file lists **may only shrink** (the file's own rule: "broadening
  requires a new ADR"). If something shrank, update the entry and say which
  release's work shrank it.
- If a category is now empty, mark it resolved **without deleting the key** — a
  disappeared category loses the record that it was ever owned.
- If a category *grew*, that is a freeze violation. **Report it, do not
  allowlist it.**

**Delete no legacy code in this stage.** Every category has an owning release;
removal happens in that release, under its exit gate.

Refresh `capturedAtSha` only if you legitimately re-baseline, and say so.

## TASK 5 — architecture document inventory

`docs/architecture/` holds 10 markdown files. Classify each in a new
`docs/architecture/README.md` under exactly one heading:

- **Normative** — binding today. `CONVEYOR-MENTAL-MODEL.md` is the arbiter; do
  not touch its content in this stage under any circumstance.
- **Historical** — a true record of completed work, kept for provenance
  (the ADR-053 cutover trackers are likely candidates — verify, do not assume).
- **Stale** — describes a plan that was superseded or abandoned.

For each: one line on what it is, and whether a reader today should act on it.
**Move nothing and delete nothing** — classification only. Relocation is a
separate decision once the classification is visible.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 305 pass, 0 fail
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
```

This stage changes no runtime code. Only `tests/architecture/` counts should
move (Task 3 adds tests). If anything else changes, investigate before
committing.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Declaring a K-release closed.** You record evidence; the architect signs the
   exit gate. If your reconciliation implies a release should be closed, say so
   in the report and stop there.
2. **Deleting any legacy category**, especially
   `recency-selector-authority-persistence` — authority-selector code, owned by
   K7–K8, and the program's top named risk.
3. **Any allowlist category that grew.**
4. **Any edit to `CONVEYOR-MENTAL-MODEL.md`.**
5. **Anything in the C-ladder.** Its entry condition is M6/K20.

## Report format

Per task: what changed, exact counts before and after, and for Task 2 the full
release → ADRs → closed/open table. List every entry you left `planned` with the
evidence you could not find.

An honest unknown is the point of this stage. A tidy registry that overstates
progress is the failure mode.
