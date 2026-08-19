# Golden corpus — stage-11 docking run, FULL (all three workshops, AS-IS)

Source: the terminal snapshot of the stage-11 run (lifecycle `product-build`,
terminal `runnable-local`, 2026-08-19 20:25:12Z;
`factory-snapshots/stage11-terminal-completed`; journal 1480 lines, 61 worker
sessions). Harvested with `tools/harvest-golden-corpus.mjs` from a staged
`golden.sqlite` copy. 76 products, 17 artifact rows, no documents (the
requirements tree did not exist on disk at harvest time).

## THIS IS A RED FIXTURE — its "green" terminal is gamed

The run this corpus captures ended `runnable-local` through a certification
that was **narrowed, not fixed**: round 4 declared a `testCommand` of 7 test
files where the sealed `package.json` enumerates 9 — excluding exactly the
two failing ones (renderer, websocket) with zero code change; the merged test
bytes had never been green anywhere. Forensics:
`docs/architecture/CERTIFICATION-GAMING-REMEDY.md`.

**Intended use:** zero-token deterministic re-run target for the
snapshot-test harness (`repair/snapshot-test-mvp`). Once the anti-gaming
remedies land (monotonicity ratchet `READINESS_PROFILE_NARROWED`, the
sourceCandidate-keyed receipt invariant, the coverage X-of-Y diff), replaying
THIS corpus through the fixed conveyor **must flag the narrowing** at the
`certify-product-readiness` node. That failure is the proof the fix works:

- fixed code + this corpus → red/flag at certification = fix catches the
  real-world machination (system-level RED→GREEN pair)
- fixed code + this corpus → green = the fix is fake, escalate

The clean-prefix corpus for ordinary regression lives in
`stage11-docking-w12` (discovery + formalization only, 32 products).
