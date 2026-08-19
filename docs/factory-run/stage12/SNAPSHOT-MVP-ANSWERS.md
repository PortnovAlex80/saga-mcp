# TASK 4 answers — snapshot-test-mvp (stage-12 night, 2026-08-20)

Read-only analysis of the held branch `repair/snapshot-test-mvp` (worktree
`D:/Development/saga-mcp-snapmvp`), evidence with file:line receipts in the
analyst transcript. Branch stays HELD — these answers inform the architect's
merge decision; they do not authorize it.

## 1. Captured corpus, or synthesized?

**Captured — but truncated.** Real stage-11 accepted material through
`plan-task-graph` (41 products / 12 documents / 17 artifacts; all 41 hashes
cross-check against `stage11-docking-full`; launch input replayed verbatim).
From `implement-work-items` onward the tail is synthesized deterministic
scripting, honestly documented in the scenario file itself (impl products
embed run-local SHAs; no content assertions are made against the corpus for
those cells). `metadata.brief_payload` is synthesized (structure derived from
captured values; the validation postdates the capture).

## 2. Gates and effects, or only the worker seam?

**Substantially more than the worker seam.** The replay spawns the real
`dist/orchestrate-cli.js`; scripted workers are real child processes through
the real stdio MCP gateway under `SAGA_MANAGED_EXECUTION=1`; the composition
substitutes only explicit ports and keeps factory authority, gates,
CandidateSets, effects and lifecycle routing as production code. GateDecisions
are asserted directly (including the captured 3-round planner repair loop
`repair_required ×2 → accepted`); settlement runs the production policy (the
run reaches `local_outcome='verified'`); the readiness gate really executes
declared commands via the real local-runnability provider. NOT directly
asserted: EffectReceipt rows; and the verification check provider is
test-only — it trusts the scripted worker's assessment where production
returns `unknown` by design.

## 3. Would it have caught the gaming? The AC drift?

**No to both, plainly.**

- **Certification gaming — no: the tape itself games the readiness gate
  benignly.** Its own handlers declare `testCommand: node -e "process.exit(0)"`
  and the gate certifies it, because the provider's stated command authority
  IS the frozen profile's declaration. The actual gaming artifact (the 7-of-9
  manifest excluding `tests/renderer.test.js` and
  `tests/websocket-server.test.js`) exists in the full corpus and is never
  replayed; a candidate submitting it in this replay would be certified and
  the test would stay green. Zero references to testCommand coverage anywhere
  in the worktree's tests.
- **AC drift — no: the corpus embodies the drift.** The order (docker /
  TypeScript / Chrome) is fed byte-verbatim, then the captured — already
  drifted — AC document is enforced as ground truth by the hash oracle. There
  is no order→AC coverage assertion; the hash oracle would fire on a
  CORRECTED AC document just as readily as on a corrupted one.

## Verdict

The tool is a **factory-machine regression harness, exactly as its own design
doc mandates** ("a test of the factory, not the worker"): it proves on real
accepted material and real production code that the factory reaches and
completes development, emits the captured gate verdict sequences, replays
captured content byte-exact through the real machinery, and strands nothing.
It is NOT an anti-gaming oracle and NOT a requirements-fidelity oracle — both
of those independent authorities are precisely TASK 2 (derived-canonical
testCommand) and the AC-drift remedy (order-derived constraint register),
already landed/landing tonight as Wave C. Recommendation to the architect:
do not block this merge on oracle duties the tool was never mandated to
carry; commission the oracles where they already live.
