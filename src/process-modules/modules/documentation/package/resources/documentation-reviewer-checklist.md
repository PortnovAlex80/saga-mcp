# Documentation Reviewer Checklist

Review the author's document product against its brief. Your verdict is
`approved` or `changes_requested` (schema `factory.documentation-review-verdict.v1`)
with concrete findings.

- [ ] Coverage: every `requiredSections` id present and substantive.
- [ ] Accuracy: features, commands and behavior match the brief material
      (SRS, acceptance criteria, repository excerpts) — no invented features,
      no silently omitted features.
- [ ] For `acceptance-report`: every acceptance criterion has an honest,
      traceable result row; no fabricated PASS entries.
- [ ] Locale/style consistent; headings meaningful; no placeholder text.
- [ ] Findings are actionable (cite the section id and what is wrong).
