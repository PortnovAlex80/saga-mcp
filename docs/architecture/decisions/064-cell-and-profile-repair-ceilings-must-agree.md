# ADR-064: Cell and profile repair ceilings must agree

Status: Accepted

## Context

Run027 exercised a legitimate progressive implementation repair. The first
author CandidateSet failed deterministic write-scope authorization. The second
passed its author Gate, then an independent reviewer found an in-scope server
startup defect. Although the implementation execution profile allowed three
author attempts, the enclosing Production Cell still declared two attempts and
paused before the third author could repair the reviewed defect.

The two declarations represented the same semantic budget at different layers
and had drifted. Existing regression coverage asserted only the execution
profile value, so the effective Cell ceiling remained unnoticed.

## Decision

The Development implementation Cell and its author execution profile both use
the same bounded ceiling of three semantic author candidates. Tests must pin
both declarations together.

Physical worker failures remain a separate engine concern and do not consume
the semantic CandidateSet ceiling. Reviewer executions also do not consume the
author ceiling. A scope rejection followed by a genuine reviewer rejection may
therefore produce one fresh third author CandidateSet and fresh review, while a
fourth semantic author attempt still pauses.

## Consequences

- Progressive correction can cross the author-Gate/reviewer boundary once.
- The deterministic Gates and independent reviewer are not weakened.
- Persistent author defects remain bounded and visible.
- Future changes to retry policy must update and test both effective layers.

