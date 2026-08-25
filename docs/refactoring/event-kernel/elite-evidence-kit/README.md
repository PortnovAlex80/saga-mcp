# Elite Evidence Kit v1 — extracted corpus

Deterministic regression corpus for the event kernel, produced by the
read-only extractor `tools/elite-evidence-kit/extract.mjs` (WP-13D / EK-9)
per `SPEC-v1.md`. The oracle is SYSTEM behavior under known actor responses
(normalized trace comparison) — never product quality.

## Layout

```
corpus/
  elite-fresh-20260825/   # success/partial — terminal development-blocked
  elite-8/                # negative — terminal failed (development-plan-task-graph)
```

Each corpus entry contains exactly the SPEC-v1 per-run contract:
`source-manifest.json`, `input-capsule/` (+ `index.json`),
`actor-program/` (`program.json` + `index.json` + content-addressed
capsules), `expected-trace.json`, `expected-invariants.json`,
`failure-witnesses/`.

The committed kit is the byte-identical output of the extractor (regenerate
and `diff -r` to prove it; see below). Sources are opened strictly
read-only (`better-sqlite3` `{ readonly: true }`, plain file reads); the raw
DB is never copied into the kit.

## Regeneration commands

Run from the saga-mcp worktree root (requires `better-sqlite3` in
`node_modules`):

```bash
node tools/elite-evidence-kit/extract.mjs \
  --source   D:/Development/elite-fresh-20260825 \
  --product  D:/Development/elite-fresh-20260825/product \
  --run-id   elite-fresh-20260825 \
  --scenario success-partial \
  --out      docs/refactoring/event-kernel/elite-evidence-kit/corpus/elite-fresh-20260825 \
  --replace

node tools/elite-evidence-kit/extract.mjs \
  --source   D:/Development/saga-mcp-ELITE7/.factory-sandboxes/elite8-db \
  --product  D:/Development/saga-mcp-ELITE7/.factory-sandboxes/elite8/product \
  --run-id   elite-8 \
  --scenario negative \
  --out      docs/refactoring/event-kernel/elite-evidence-kit/corpus/elite-8 \
  --replace
```

Determinism proof (two fresh runs must hash identically):

```bash
node tools/elite-evidence-kit/extract.mjs --source <src> --product <prod> \
  --run-id <id> --scenario <scn> --out /tmp/ek-run1
node tools/elite-evidence-kit/extract.mjs --source <src> --product <prod> \
  --run-id <id> --scenario <scn> --out /tmp/ek-run2
(cd /tmp/ek-run1 && find . -type f | sort | xargs sha256sum) > /tmp/1.sums
(cd /tmp/ek-run2 && find . -type f | sort | xargs sha256sum) > /tmp/2.sums
diff /tmp/1.sums /tmp/2.sums   # must be empty
```

Verified 2026-08-26: both corpora byte-identical across double runs
(elite-fresh-20260825: 76 files; elite-8: 90 files).

## Source digests (pinned by each `source-manifest.json`)

| Digest | elite-fresh-20260825 | elite-8 |
|---|---|---|
| DB content digest (read-only canonical dump) | `65e6e6cd7f46d9b3fe0bf555d606477571552571b2318f8f42a8f5efe1407634` | `095e96d01165751d47fd119c0d1068914991506c24002ac634577973b5098817` |
| Journal digest (`factory-run-journal.jsonl`) | `82db4b826a020ed07f785408dc35b11f881478a235475566b1a243b46d21fb37` | `61a3300f0648fb3cebc1041b9524d9ea8bed73374773aa569cc6b620fb42faea` |
| Package-store Merkle digest | `cd94d031f75b264902633c90802d2b13dccbb2fc193d545fdc8249bba86050e6` | `00250ba657ccbc9a5cb28b76bf2d1190eff2788ec74181d649c45567bc62db17` |
| Build digest (module installations) | `9991ede633107afb8443eb6dde8176354968329b0edbacf061a01444a863ea52` | `9bfa5566d7df079965cdcfc24fd0380924b8b7aed16b2a84708b0bb886b03e27` |
| Source SHA (derived — see note) | `297a3168ed6c67f05f0516263e840ca72ea97e15455b251c437af62d6d943d69` | `273a13a997bab1bdc076eeac879789ac4f32176b4232f3bd6ca61f2fcc429af0` |
| Product repo commit (direct) | `3cc360a3306c89154e4da9071eb3b6699ed940c8` | `b6db0253e96a787e786d500d3696d8128836ef8e` |

Provenance honesty:
- `sourceSHA` is **derived** (package-store digests + built-in provider
  bases + schema version pinned by the DB) because the factory checkout that
  produced these runs is not archived with the run roots. It identifies the
  executing factory code as strongly as the data allows.
- `repoCommitDigest` is **direct** (read-only `.git/HEAD` resolution of the
  product repository each run wrote to).
- Old `factory_replay_capsules` are intentionally NOT transferred
  (ADR-079 packageDigest in the replay key — legal miss after kernel
  replacement; see SPEC-v1 greenfield constraint).

## Extraction status (as committed)

| | elite-fresh-20260825 | elite-8 |
|---|---|---|
| Verified terminal state | `development-blocked` (matches SPEC) | `failed` (matches SPEC) |
| Tasks / workplaces | 30/30 done; 17 workplaces (16 accepted, 1 failed) | 16/16 done; 8 workplaces (7 accepted, 1 failed) |
| Gate decisions | 29 accepted / 1 failed (matches SPEC claim) | 8 author accepted, 7 final accepted, 9 repair_required |
| Obligations (REG-28 drain) | 86/86 completed | 54/54 completed |
| Invariant checks | 13/13 pass, 0 fail | 13/13 pass, 0 fail |
| SPEC claim mismatches | none | none |
| Input capsules / actor capsules | 35 / 28 | 41 / 29 |
| Normalized trace | 876 events, 82 streams | 665 events, 72 streams |
| Failure witnesses | 7 | 14 |

## Recorded data findings (see `failure-witnesses/`)

- `journal-visibility-gap-lost-executions` (both runs): some DB-marked
  `lost` executions never emit a `supervision.reaped` journal event; the
  loss is auditable only via the DB row (`state` + `last_error`) and the
  successor execution that re-did the task. No phantom executions (INV-07
  checks completion products and supervision evidence explicitly), but a
  replay must reproduce these losses from DB-side state.
- `journal-duplicate-obligation-created` (both runs): `obligation.created`
  is re-emitted for the same key across engine restarts (idempotent append
  re-emission); one DB row, exactly one settlement. Trace comparators must
  dedupe created-events by key.
- `engine-restarts` (both runs): engine exits (`paused`/`fatal`) mid-run
  with later typed-terminal completion — restart tolerance is part of the
  observed system behavior and of the expected trace.
- Elite-8's failure point is the `development-plan-task-graph` production
  cell: nine `repair_required` final-gate verdicts over task-graph contract
  violations (scope overlap without dependency order, AC coverage gap
  AC-14, uncovered SRS modules), then honest terminal `failed` with the
  formalization chain intact (INV-09) and the product repo left at its
  initialization commit.
- Elite-fresh's refusal point is `development-readiness-certification`:
  `factory.local-runnability.v1` failed on `npx vitest run` (WebSocket
  port already in use; `describe is not defined` — broken test harness in
  the generated product), propagated honestly to `development-blocked`.
  Test infrastructure, not a product defect.
