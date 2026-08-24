# Documentation Writer Checklist

Before `worker_done`, verify:

- [ ] Document kind matches the brief (`user-manual` / `programmer-manual` / `operator-manual` / `acceptance-report`).
- [ ] Every `requiredSections` id from the brief is present exactly once.
- [ ] `generatedFor.candidateHash` equals the brief's `candidateHash`.
- [ ] All statements trace to the brief (SRS, acceptance criteria, file excerpts); nothing invented.
- [ ] For `acceptance-report`: every acceptance criterion has a row with an honest result.
- [ ] Product submitted via `product_submit` with schema `factory.documentation-document.v1`.
- [ ] No repository files were modified.
