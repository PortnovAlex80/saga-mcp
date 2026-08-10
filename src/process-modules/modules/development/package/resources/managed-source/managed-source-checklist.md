# Managed source checklist

- Exact `baseCommit` equals the Factory source-snapshot receipt.
- `workItemKey` equals the assigned item key.
- Every changed path is declared in `changeScopes`; no `.git`, traversal, binary, symlink, submodule, or executable-mode change.
- The submitted full file bodies jointly satisfy all assigned acceptance criteria.
- Existing accepted baseline behavior is preserved unless the recovery contract explicitly changes it.
- Relevant deterministic checks and remaining risks are recorded in `tests` and `reasonCodes`.
