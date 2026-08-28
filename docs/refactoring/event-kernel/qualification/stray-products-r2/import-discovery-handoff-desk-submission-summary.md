# import-discovery-handoff desk — author submission summary (r2)

**Desk:** import-discovery-handoff (shell stage)
**Role:** author
**Submission ID:** FS-Import-Discovery-Handoff-002
**Submitted:** 2026-08-28T00:00:00Z (pinned, deterministic)
**Workspace:** 0 accepted upstream revisions travel by content address

## What was authored

| Artifact | Content address |
|---|---|
| Discovery-import product (`formalization.discovery-import.v1`) | `sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5` |
| Discovery-import trace | `sha256:2e5bb8ce3f26de726729c107760d43d5c81350b1a412f5c504d95352a0ef8274` |
| Product submission + intake receipt | `sha256:2a7392591b0f7177b8a4b4fe09ee83c563fb4da021af809b4157810a87acc21e` |

## Verified imported material (ingress law, check order preserved)

- **Protocol:** `ek.discovery-handoff-capsule.ek8-wp11f.v1` — CURRENT (no `STALE_PROTOCOL`).
- **Capsule self-address:** `sha256:f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e` verifies over canonical facts (no `BYTES_CORRUPT`).
- **Package bytes:** present; digest `8c9ab70944cf2ff76912a1a31f500219221713e0970dfd0dd548e3db4df27c93` (no `BYTES_MISSING`).
- **Sub-artifacts:** all eight digests RECOMPUTED over canonical content and matched the task projection exactly (declared digests never trusted):
  - SC-1 `claim:scope-1` → `b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909`
  - SC-2 `claim:scope-2` → `cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da`
  - SC-3 `claim:constraint-1` → `6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b`
  - SC-4 `claim:outcome-1` → `3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0`
  - CON-1 `constraint:retention-1` → `807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be`
  - UNK-1 `unknown:browser-matrix-1` → `38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf`
  - TC-1 `terminal:audited-1` → `4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f`
  - TC-2 `terminal:delivered-1` → `8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988`
  - CERT-1 (discovery certificate, decision **go**) → `03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21`
- **Lineage binding:** `lineage:message-service-2026-08`, parent `sha256:0794e660975e42cc2ff850b9e9a3ccbde49fccad93149a4958e76d2be8fc2dde` (no `FOREIGN_LINEAGE`).
- **Parent state:** exactly `discovery-terminal`, terminal proof `sha256:4a919f529fa661d2bbd39688c1996eaabaa309d521fae6ae28a648bd54c007fd` (no `ILLEGAL_PARENT_STATE`).
- **Fresh run:** 0 active attempts in the target world (no `ACTIVE_ATTEMPT`).

## Dispositions

- **constraint:retention-1** — honored: all authored desk content is deterministic (pinned timestamp, no clock reads, no randomness, canonical-JSON digests only).
- **unknown:browser-matrix-1** — carried forward, owner `discovery`: imported verbatim with the capsule; this desk records NO resolution edge for it (honest open item).

## Trace coverage

- `terminal:audited-1`: derived from all four source claims, constrained by `constraint:retention-1`.
- `terminal:delivered-1`: derived from all four source claims, constrained by `constraint:retention-1`, supported by the discovery-import artifact.
- The unknown travels with the capsule and is documented in `unknownCoverage` — no fabricated resolution.

## Governing contract

`AC-Import-Discovery-Handoff-001` (`sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837`, protocol-skill layer of this desk task). All ten acceptance criteria are self-checked in the submission payload.

## Hand-off

Candidate admitted for the **reviewer** stage. Kernel-side ingress (`ingestDiscoveryHandoff` over `factoryRun.bootstrap` + `factoryRun.importCapsule` on a fresh database) is executed by the driver over public commands; this desk records file-level intake only.

**Digest rule (all artifacts):** sha256 over canonical JSON of `content` (recursively key-sorted, compact); envelope refs derive from that digest.
