# Normalization Submit Checklist

Read normalization-call-{EPIC_ID}.json and verify EVERY item:

- [ ] control_intent_id is an integer (NOT inside payload)
- [ ] source_submission_id is an integer (top-level arg, ALSO inside payload)
- [ ] execution_id is a string in quotes (top-level arg)
- [ ] schema_version is exactly "factory.discovery-normalization-proposal.v1" (top-level arg, NOT inside payload)
- [ ] payload.source_submission_id matches the top-level source_submission_id
- [ ] payload.source_raw_hash is the EXACT 64-char hex from normalization_get
- [ ] payload.normalized_payload is a valid DiscoveryProposal:
  - [ ] problem_statement, observed_context, candidate_scope, rationale — non-empty strings
  - [ ] stakeholders_or_actors, assumptions, unknowns, risks — non-empty arrays
  - [ ] evidence_refs — array; every ref from allowed_source_refs
  - [ ] recommended_outcome — one of: go, clarify, reject (the only outcomes the factory can emit from a recommendation; anything else is invalid input)
- [ ] payload.source_field_map: every canonical proposal field has an entry
- [ ] every source_field_map path is a REAL top-level path in the source payload (no invention)
- [ ] payload.notes is an array (may be empty)
- [ ] no FILL_ placeholders remain
- [ ] no forbidden authority fields (new_outcome, override_decision, approved, settled, transition_stage, new_certificate)

## Decision-specific rules
- The normalized_payload.recommended_outcome must be DERIVED from the source
  payload (do NOT invent a new recommendation). If the source states no
  recommendation — or states one outside go / clarify / reject — that is
  INVALID INPUT: fail closed and report the gap in payload.notes. Do not
  default, translate or invent a recommendation.
