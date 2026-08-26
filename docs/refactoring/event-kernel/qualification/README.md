# Event-kernel qualification (EK-11/EK-12, WP-15)

This directory owns the QUALIFICATION artefacts of the event-projected
kernel: immutable kit manifests (`kits/`), per-series result records
(`series/`), and the result document (`EK-11-RESULTS.md`). Raw evidence
(journals, receipts, traces, product repositories, kernel databases) lives
OUTSIDE the source checkout under the build-addressed evidence root
(`D:/Development/ek-qual-evidence/<kitId>/<series>/…` by default, override
with `EK_QUALIFY_EVIDENCE_ROOT`); each series root carries a hashed
`evidence-manifest.json` whose digest the series record binds.

Driver surface (package.json):

- `npm run qualify:kit -- --freeze | --verify --kit <path-or-id>` — the
  immutable, content-addressed qualification kit.
- `npm run qualify:development -- --kit <kit> [--series <id>]` — the ten-run
  development reliability series.
- `npm run qualify:projects:scripted -- --kit <kit> (--all | --project <id>)`
  — the twenty-project scripted corpus with per-kind product-output
  verification.
- `npm run qualify:concurrency -- --kit <kit>` — the concurrency proofs.
- `npm run qualify:projects:real -- --kit <kit> --series R1,R2,R3 [--execute]`
  — the EK-12 real-OpenCode series (prewired; refuses to execute without
  `--execute`).
- `npm run qualify:proof` — the RED/GREEN fence + alignment + product-family
  proof harnesses (`tests/qualify/*.proof.mjs`).

Laws enforced by every driver start: clean tree (untracked files under this
directory are the ignorable class), kit digest verification (typed drift
refusal), fresh paths (a reused path refuses), evidence outside the source
tree with a hashed manifest, and the receipt-completeness law per run.
