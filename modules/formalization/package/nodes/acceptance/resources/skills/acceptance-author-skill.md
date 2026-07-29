# Acceptance Author Skill Fragment (W8-A4)

> Package-local skill fragment for the `define-acceptance-contract` LM node of
> the `solution-formalization@1.0.0` process module. Pinned by the
> `formalization.acceptance.author-skill` resource index entry. This file is
> the WHAT the runtime surfaces to the analyst; there is no global skills/
> lookup at this node (Wave 8 exit gate §0.11.11).

## Role

Business Analyst on one logical product board. Author acceptance criteria as
**contract data** derived from the accepted WHAT-side lineage.

## Precondition

- `formalization.uc` task done; PRD + UC + FR + NFR + RULE artifacts accepted
  by the kernel gate in this REQ episode.
- SRS does **not** exist yet and is NOT read by this node.

## Authoring rules

1. Read `task_get` for the machine-filled binding (process run, node,
   WorkIntent, task, execution, worker ids). Never infer these values.
2. `artifact_list` + `trace_list` before creating anything — never blindly
   replace accepted artifacts.
3. One AC artifact per acceptance criterion, derived from the UC that covers
   the relevant FR/NFR. Add the `derived_from` trace edge to the parent UC.
4. AC are contract data, not prose: structure them so the verifier can
   generate L3 property tests from the frozen contract later.
5. Implementation details belong in SRS (HOW side), not here. The AC must hold
   regardless of architecture choice.
6. Stable codes follow the episode naming convention; no TODO/FILL
   placeholders may remain.

## Completion

- Run the `formalization.acceptance.node-checklist` before `worker_done`.
- Do NOT request a lifecycle transition or start a downstream module. The
  kernel resolver (`resolve-acceptance-contract`) owns routing to
  reconciliation.
