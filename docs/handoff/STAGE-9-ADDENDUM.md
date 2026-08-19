# Stage 9 addendum — one entry blocks the K13 signature

Your K13 train is accepted. Verified independently before writing this:

- `npm run build` exit 0; architecture **317/317**, lifecycle **114/114**,
  process-modules **1057/1057**, infrastructure **314 pass / 0 fail / 12 skip**;
- the one-writer ratchet **negatively validated by the architect's own hand**, not
  taken from your report: a rogue `INSERT` appended to
  `dist/app/product-lifecycle-runtime.js` turned it RED naming that exact file;
  reverted, GREEN 3/3;
- the two fixture-repair commits inspected — both legitimate. `c5-carry-forward`
  moves *with* the release (commit 2 now requires the subject chain);
  `lifecycle-outcome-routes` was red **at the base** because stage 3 deleted the
  dead vocabulary on both sides, and you updated the pin to the live contract
  while the derived no-orphan/no-missing cross-checks still hold. Neither
  weakened an assertion. Calling out the pre-existing red instead of absorbing it
  was the right call.

Identifying the permitted writer **by import rather than by string** — so a path
drift fails the exemption and the import together — is better than the brief
asked for.

**But I cannot sign the gate yet, and the mechanism you built is why.**

---

## The blocker

Closing `releases.K13` trips your own stage-5 rule:

```
[CLOSURE_LAGS_RELEASES] ADR-032: all owning releases (K10,K11,K12,K13) are
closed but the entry is still planned without a note naming the missing evidence
```

`docs/architecture/decisions/032-development-integrated-candidate.md` —
principal proof *"Workplace revision CandidateSet; Gate-proven acceptance"* —
carries `notes: null` and no evidence. Owners K10–K13, every one of them closed
except the release I am being asked to close.

This is not paperwork. ADR-032 is the material-authority spine that K10–K13
exist to build. Signing "Authority-Correct Beta" while its central decision has
zero recorded evidence is exactly how ADR-039 rotted into a live defect: a
release closed against a decision nobody had substantiated.

Your reconciliation was right to leave it rather than invent a state. Now it
needs the evidence.

## TASK — reconcile ADR-032

Read the ADR, then establish which is true:

**(a) It is delivered** — K10–K13 built precisely this. Then close the entry and
fill `evidence[]` from the real proof: suite names and counts, the boundary
manifest, the ratchets that keep it closed. Use the shape of ADR-080/081, which
are correct.

**(b) Something in it is genuinely unproven.** Then leave it `planned` and write
the note naming exactly what is missing, in the style you already used for
ADR-062 and ADR-065 — both of which are good: they name the gap and the owner
rather than gesturing at it.

**Do not manufacture evidence to unblock the signature.** If (b) is the answer, I
decide whether the gap blocks M3 — that is my call, not a reason to write (a).

## Also worth ten minutes

ADR-062's note says *"Owner: a review-scope release after M3."* No such release
exists in the ladder. Either name the real owner or say plainly that the owner is
undecided. A pointer to a release that does not exist is how work disappears.

## Verification

`node tools/adr-closure-registry.mjs` must report zero violations **with
`releases.K13.state` temporarily set to `closed`** — that is the actual
precondition for my signature. Revert it to `open` before you commit: flipping
the release state is my act, not yours, and the test pin still enforces that.

Report which of (a)/(b) you found, and the evidence or the gap.
