# Current-Document Linter — SPECIFICATION (WP-14, spec only — no implementation in this package)

> **Status: SPEC.** This document specifies the current-document linter whose
> implementation lands at EK-10 as the blocking command
> `npm run test:docs-current` (plan Phase EK-10: "Add a current-document
> linter that fails on …"). The linter enforces the documentation laws of
> `docs/CURRENT-DOCUMENTS.md` (the sole active index) against the deletion
> dispositions frozen in `DOCUMENT-DELETION-MANIFEST.md`.
>
> **Invariants of the linter itself:** deterministic (same tree → same
> verdict); no network; reads the tree and the frozen machine artifacts only;
> every failure carries a machine-stable code and a human-remediable message;
> no allowlist entry may silence a failure class (allowlists are enumerated
> below and may only shrink).

## 0. Inputs

1. `docs/CURRENT-DOCUMENTS.md` — the active index (authoritative list of
   retained documents, the canonical eight, the ADR list, the fold map).
2. `docs/architecture/adr-closure-registry.json` — the explicit ADR list
   (registered decision history is indexed by the registry, not by hand).
3. `docs/refactoring/event-kernel/DOCUMENT-DELETION-MANIFEST.md` — frozen
   KEEP/REWRITE/DELETE dispositions (439 entries, zero unclassified).
4. `docs/refactoring/event-kernel/LEGACY-DELETION-MANIFEST.md` — deleted
   production symbols/tables/commands for class C3 (see below).
5. The tracked file tree (`git ls-files`) plus generated-artifact
   fingerprints emitted by the graph-generation tooling.

## 1. Failure classes

### C1 — retained document absent from the index

**Definition.** A tracked documentation file exists in the tree but is
referenced by neither the active index (`docs/CURRENT-DOCUMENTS.md`),
nor the ADR closure registry, nor an explicitly enumerated evidence root
(`tests/fixtures/golden-corpus/**`, `docs/factory-run/qualification-adr096/**`,
workshop package-resource paths re-hosted per manifest §S), nor a live
refactoring record under `docs/refactoring/event-kernel/**` while its phase is
open. Conversely, an index row naming a path that does not exist is the same
failure (dangling index row).

**Detection.** Set-difference between the tree's documentation files and the
union of the index rows, registry entries and enumerated roots; plus an
existence check for every indexed path.

**Failure code.** `DOCS_NOT_INDEXED <path>` / `DOCS_INDEX_DANGLING <path>`.

**Rationale.** One index is the law; an unindexed retained document is either
undeleted legacy or an undocumented addition — both block.

### C2 — broken link

**Definition.** A Markdown link, Markdown image reference, or relative URL in
any retained document (and in the index itself) that does not resolve to an
existing tracked file (or explicit anchor within it) in the current tree.
Covers links that pointed at documents deleted by the purge and links that
were always wrong.

**Detection.** Parse every retained `.md`; resolve relative links against the
linking file; verify target existence; verify intra-document anchors; flag
absolute repo paths that don't exist. External URLs are out of scope
(no network).

**Failure code.** `DOCS_LINK_BROKEN <file>:<line> -> <target>`.

**Rationale.** After mass deletion, the surviving graph of references must
close. Git history is the archive; the working tree must not point into it.

### C3 — deleted symbol/table/command presented as current

**Definition.** A retained document presents, as **current** operational
truth, an identifier (table, column, command, npm script, CLI flag, env var,
file path, API endpoint, error code) that the legacy deletion manifest or the
document deletion manifest classified DELETE, or that no longer exists in the
tree.

**Detection.** Extract the identifier corpus from the deletion manifests
(old table names, old commands, old npm scripts, removed endpoints such as
direct card-status APIs, removed env switches, retired tool names) plus an
existence-derived corpus (npm scripts in `package.json`, files, exported
commands). Scan retained documents for those identifiers **outside historical
context**; a match is a failure unless the occurrence is (a) inside an
explicitly marked decision-history artifact (ADRs, closure matrices,
FINAL-RECEIPT, the deletion manifests themselves, the plan) or (b) inside a
clearly marked historical/quote block in a canonical document. The marker set
is fixed by this spec (e.g. code-fence or "legacy:" prefix convention); prose
that merely mentions a deleted thing as deleted is fine — prose that
instructs an operator or agent to use it is not.

**Failure code.** `DOCS_SYMBOL_DELETED <file>:<line> symbol=<id>`.

**Rationale.** The most dangerous post-purge defect is a current-looking
document that teaches the old runtime. This class is the reason the linter
exists.

### C4 — multiple primary runbooks / status pages

**Definition.** More than one retained document claims, by title, front
matter, self-description or repository convention, to be *the* primary
runbook, *the* live status page, *the* factory start instruction, *the*
documentation index, or *the* first-read agent instruction. After the purge
exactly one document holds each primary role:
`docs/operations/FACTORY-RUNBOOK.md` (runbook/start),
`docs/CURRENT-DOCUMENTS.md` (index), `AGENTS.md` (first-read).

**Detection.** Scan retained documents for primary-role claim markers
(normalized titles like "единая инструкция запуска", "runbook", "live
status", "читать первым", "the sole index", `Status: live`/`Status: активна`
front matter, and equivalent phrases in the frozen marker list); count
claimants per role. A second claimant for an occupied role is a failure even
if it is otherwise indexed.

**Failure code.** `DOCS_PRIMARY_DUPLICATE role=<runbook|status|index|first-read> <path>`.

**Rationale.** Live-status pages and duplicate runbooks are precisely what
rotted between stages; the purge deletes them and this class keeps them
dead.

### C5 — stale generated graph fingerprint

**Definition.** A generated artifact (forward/reverse/reconciliation graphs,
acceptance matrices, census outputs — the set enumerated in the index as
generated) carries a fingerprint/digest header that does not match the digest
recomputed from its declared inputs (frozen universe/spec files or source
measurement) on the current tree; or a generated artifact exists without a
fingerprint header; or its source-of-truth input changed without regeneration.

**Detection.** For each generated artifact: recompute the declared
input digest deterministically (same rule as the generating tool), compare
with the recorded fingerprint; verify the artifact's own self-declared
digest; verify the generator's measured outputs are current (run the
read-only measurement command where one exists).

**Failure code.** `DOCS_GRAPH_STALE <artifact> recorded=<digest> recomputed=<digest>`.

**Rationale.** Static maps that no longer reflect the protocol are worse than
none; this is the documentation instance of the projection law.

## 2. Verdict model

- One pass/fail per class; the command fails on **any** failure
  (`DOCS_LINT_FAILED count=<n>`) and prints every occurrence with its stable
  code and remediation hint.
- Exit is deterministic and independent of file order; occurrences are sorted
  by class, then path, then line.
- The linter never deletes, moves or rewrites anything: it only refuses.

## 3. Explicit allowlists (shrink-only)

1. **Historical-context exemption list** for C3: the ADR registry entries,
   the deletion manifests, the closure matrices, the qualification receipts,
   `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md` and
   `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md` (through
   their pinned lifetimes).
2. **Evidence roots** for C1: golden corpus fixtures, qualification-adr096
   records, factory-proof evidence notes.
3. **Open refactoring records** for C1: `docs/refactoring/event-kernel/**`
   while the EK plan is open; their disposition after closure is pinned by
   FINAL-RECEIPT.

Any new allowlist entry requires a coordinator-reviewed change to this spec;
the CI also fails if an allowlisted path disappears (so deletions actually
land).

## 4. Required mutations (for the linter's own tests, EK-10)

Each mutation must flip the linter red; without the mutation it is green:

1. add an unindexed retained `.md` → C1;
2. add an index row for a nonexistent path → C1;
3. break one relative link in a canonical document → C2;
4. re-add a paragraph instructing use of a deleted table/command as current
   → C3;
5. add a second document claiming to be the primary runbook → C4;
6. edit a frozen input under a generated graph without regenerating → C5;
7. remove an allowlisted path that an allowlist still names → C1-side
   failure (allowlist hygiene).

## 5. Non-goals

- No prose-quality or style judging.
- No external link validation (no network).
- No automatic repair, migration or archival suggestions beyond a remediation
  hint naming the owning canonical document.
- No suppression mechanism other than the enumerated, shrink-only allowlists.
