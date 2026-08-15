# Security review axes for SRS artifacts

Companion file to `SKILL.md`. Used during the **Security review** phase. The
reviewer applies every axis below to the SRS under review and emits a per-axis
verdict: **`pass` / `fail` / `N/A`**.

Scope rule: this is an *architectural-contract* review, not a code audit. A
`fail` means the SRS is silent, contradictory, or under-specified on a security
control the episode's surface area *requires* — not that the eventual code will
be wrong (that is the verifier's job on the AC). Every `fail` becomes an entry
in the verdict's gap list and, when it concerns a checkable architectural
property, is promoted to an **Invariant Registry** violation (see SKILL.md
"Security review" phase for the wiring).

CGAD terminology is preserved throughout: AC, episode, baseline, scope-condition.
The reviewer never self-authorizes; all verdicts route through `worker_done`.

---

## 1. OWASP Top 10:2025 checklist

<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
The 2025 list and mitigation guidance below are ported from
`agamm/claude-code-owasp` (`.claude/skills/owasp-security/SKILL.md`), which
itself tracks the official OWASP Top 10:2025. For each category, the reviewer
asks: *does the SRS declare a control for every episode surface that this
category touches?* If the episode has no relevant surface, verdict is `N/A`
(with one-line justification).

| # | Category (2025) | Reviewer question for the SRS | Verdict inputs |
|---|---|---|---|
| A01 | Broken Access Control | Does the SRS declare an authz model (RBAC/ABAC/scope) for every module that enforces who-can-do-what? Are trust boundaries drawn in §2.2 Module Manifest? | §2.2 module surfaces; §D2 rows touching authz; §2.3 invariants if any |
| A02 | Security Misconfiguration | Does the SRS name a secure-defaults posture (CORS, headers, rate limits, TLS floor, least-privilege runtime) and forbid insecure defaults? | §9 stack (does it pin versions?); §10 for L/XL; §12 Decision Log |
| A03 | Software Supply Chain Failures *(new weight in 2025, was A08:2021)* | Does the SRS declare dependency provenance, lockfile policy, and SBOM/integrity expectations for every third-party module in §D1? | §D1 file tree; §11 External Landscape rows; §9 build tool |
| A04 | Cryptographic Failures | Where the episode stores, transits, or hashes secrets: does the SRS name algorithms, key management, and a "classify data in transit/at rest" decision? | §2.3 invariants for any crypto formula; §11 protocol+auth columns; §12 crypto decision |
| A05 | Injection *(now spans SQLi, NoSQLi, OS-cmd, XSS, header, log injection in 2025)* | Does the SRS declare input-validation boundaries (where untrusted data enters, where it is rendered/queried) per §D2 row that touches external input? | §D2 rows with `external_protocols:`; §11 endpoints; §2.2 module manifest entry points |
| A06 | Insecure Design | Does the SRS declare threat-modeling output (abuse cases, rate limits, state-machine for authz) rather than only happy-path? Absent abuse cases for security-sensitive modules → `fail`. | §2.1 architectural style; §D4 pattern selection rationale; §12 Decision Log |
| A07 | Identification and Authentication Failures | Where the episode authenticates: does the SRS declare credential storage, session/token lifecycle, MFA surface, and lockout? | §11 endpoints with `Auth` column; §2.2 auth module if any |
| A08 | Vulnerable and Outdated Components | Does §9 pin concrete versions (not `latest`) and does §12 record the upgrade/patch cadence decision for each runtime dependency? | §9 stack entries; §12 Decision Log |
| A09 | Integrity Failures *(Software & Data Integrity, was A08:2021)* | Does the SRS declare integrity verification (signatures, subresource integrity, CI provenance attestation) for code/data the episode consumes from untrusted pipelines? | §11 External Landscape; §10.2 Software for L/XL; §D2 rows consuming external artifacts |
| A10 | Mishandling of Exceptional Conditions *(NEW in 2025)* | Does the SRS declare fail-safe behavior for security-relevant exceptions (do errors leak secrets? do partial failures leave authz open? are timeouts bounded)? Each security-sensitive module must state its exception posture. | §2.3 invariants; §D4 pattern rationale; §12 Decision Log |

### OWASP axis verdict rules
<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
- `N/A` is only valid when the episode provably has no surface for that
  category (e.g. a pure-computation episode with no I/O → A05/A07/A11 `N/A`).
  The reviewer must write the one-line justification in the verdict body.
- `fail` on A01, A04, A05, A06, or A10 for a security-sensitive episode is a
  **blocker** — these map to checkable architectural properties and are
  promoted to Invariant Registry violations (see SKILL.md). The SRS is returned
  `changes_requested`; the architect must add the missing §2.3 invariant(s)
  and/or the missing §2.2 trust-boundary declaration.
- `fail` on A02/A03/A07/A08/A09 is `changes_requested` with the specific gap,
  unless the gap concerns a checkable predicate (then it is also promoted to an
  invariant violation).

---

## 2. ASVS 5.0 checklist (verification levels L1 / L2 / L3)

<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
The three-level model and the "which level for this episode" decision are ported
from `agamm/claude-code-owasp`, tracking OWASP ASVS v5.0.0. ASVS levels are
**cumulative**: L2 ⊇ L1, L3 ⊇ L2.

### 2.1 Pick the target ASVS level for the episode
<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
Map the episode's assurance need to a level BEFORE running the per-chapter
checks. Default level comes from the brief; if the brief is silent, use the
table.

| Episode signal (from brief + PRD) | Target ASVS level |
|---|---|
| Pure computation, no sensitive data, no external I/O | **L1** (baseline) |
| Handles user data, business logic, or any external contract | **L2** (standard — the default for most product episodes) |
| Touches payments, credentials, safety-critical control, regulated data (PII/PHI/PCI), or agent-executed privileged actions | **L3** (advanced) |

### 2.2 Per-chapter ASVS coverage check
<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
For the chosen level, verify the SRS declares coverage for every ASVS chapter
that the episode's surface activates. Verdict per chapter: `pass` (SRS declares
the control at the target level), `fail` (SRS silent/under-specified), `N/A`
(chapter not activated by this episode's surface, with justification).

| ASVS chapter (v5.0) | Reviewer question | Activated when |
|---|---|---|
| V1 Architecture & Threat Modeling | Does the SRS §2.1 declare architecture, §2.2 trust boundaries, and §D4 pattern rationale that a threat model could be derived from? | Always (L1+) |
| V2 Authentication | Does the SRS declare the authN mechanism, credential storage, and failure handling for every authn surface? | Episode authenticates any principal (L1+) |
| V3 Session Management | Does the SRS declare session/token lifecycle, timeout, and rotation? | Episode maintains sessions (L1+) |
| V4 Access Control | Does the SRS declare the authz model and where it is enforced (mirrors OWASP A01)? | Episode enforces who-can-do-what (L1+) |
| V5 Input Validation & Output Encoding | Does the SRS declare validation boundaries and output encoding (mirrors OWASP A05)? | Episode consumes external input or renders untrusted data (L1+) |
| V6 Cryptography at Rest | Does the SRS name algorithms, key storage, key rotation for at-rest secrets (mirrors A04)? | Episode stores secrets (L2+) |
| V7 Cryptography in Transit | Does the SRS declare the TLS floor, certificate handling, and mTLS where applicable? | Episode transits data over a network (L2+) |
| V8 Error Handling & Logging | Does the SRS declare fail-safe error posture (mirrors A10) and log hygiene (no secrets in logs)? | Always (L1+) |
| V9 Communications Security | Does the SRS declare channel integrity for inter-service calls? | L/XL with >1 service (L2+) |
| V10 Malicious Input | Does the SRS declare limits on input size, structure, and resource cost (anti-DoS)? | Episode accepts external input (L2+) |
| V11 Business Logic | Does the SRS §2.3 declare invariants for business rules and anti-fraud checks? | Episode has algorithmic FRs (L2+) |
| V12 Files & Resources | Does the SRS declare upload/download validation and path-traversal controls? | Episode handles file I/O (L2+) |
| V13 API & Web Service | Does the SRS declare API authz, rate limiting, and schema validation per §11 endpoint? | Episode exposes an API (L2+) |
| V14 Configuration | Does the SRS declare secure defaults and secret management (mirrors A02)? | Always (L1+) |
| V15 Stored Cryptography (key management) | Does the SRS name the KMS/HSM or secret store and key lifecycle? | L3 episodes handling credentials/keys (L3) |
| V16 Architecture Deep Defense | Does the SRS declare layered defenses, isolation boundaries, and blast-radius limits? | L3 episodes (L3) |
| V17 Security Operations | Does the SRS declare monitoring, alerting, and incident hooks (for L/XL via §10)? | L3 / L+XL episodes (L3) |

### ASVS axis verdict rules
<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
- A chapter marked `N/A` still requires the one-line justification in the
  verdict body (e.g. "V15 N/A — episode stores no credentials").
- A `fail` on V1, V4, V5, V8, V11, or V14 (the L1 chapters) is always a
  **blocker** regardless of target level — these are first-layer defenses.
- A `fail` on an activated L2/L3 chapter is `changes_requested`; if the
  missing control is a checkable architectural predicate, promote it to an
  Invariant Registry violation.

---

## 3. Agentic-AI threats checklist

<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
The agentic-AI threat list below is ported from `agamm/claude-code-owasp`, which
combines the OWASP Agentic AI Security Initiative 2026 (ASI series) and the
OWASP Top 10 for LLM Applications 2025 (LLM series). Apply this axis ONLY when
the episode produces or governs an LLM/agent component (an SRS that declares an
agent loop, tool-calling, RAG, or model invocation in §2.1/§2.2). Otherwise the
whole axis is `N/A` with justification "episode has no agentic surface".

For each threat the reviewer asks: *does the SRS declare an architectural
control that bounds this risk?*

| Threat | What to look for in the SRS | Maps to OWASP |
|---|---|---|
| **Prompt injection** (direct + indirect via tool output / retrieved docs) | §2.2 declares a privilege boundary between instructions and data; §2.3 declares an invariant that tool/agent output is treated as untrusted data, not commands; §D4 pattern rationale names the isolation. | LLM01:2025 |
| **Sensitive information disclosure / data exfiltration** | SRS declares what model/agent may NOT emit (PII, secrets, source), and the channel for agent output is bounded; no invariant allows raw DB read into a prompt. | LLM02:2025 |
| **Tool abuse / weaponized tools** | §D2 tool surfaces are least-privilege; each tool's blast radius is named; §2.3 declares an invariant that tool invocations are scoped per-task. | LLM06:2025 (excessive agency) + agentic |
| **Excessive agency** (agent can act beyond the AC's intent) | SRS declares the agent's action set is closed (allowlist), not open; every agent action maps to an AC; no "agent decides what to do" without a bounded policy. **CGAD guard:** this is also a no-self-authorization check — the agent may not authorize its own retries/completion/degradation. | LLM06:2025 |
| **Supply chain** (model weights, plugins, tool poisoning) | §9/§11 declare provenance for any model/plugin dependency; pinned versions; §12 records the trust decision for each. | LLM03:2025 / A03:2025 |
| **Data and model poisoning** | For RAG/training surfaces: SRS declares the trust level of ingested data and a validation invariant. | LLM04:2025 |
| **Improper output handling** (agent output rendered/eval'd unsafely) | §D2 rows consuming agent output declare validation/encoding before use (mirrors A05). | LLM05:2025 |
| **System prompt leakage** | SRS declares that prompts containing secrets/policy are not logged or returned to untrusted callers; §2.3 invariant if checkable. | LLM07:2025 |
| **Vector/embedding weaknesses** (for RAG episodes) | §2.2 declares the embedding store's access control and input filtering. | LLM08:2025 |
| **Unbounded resource consumption** (token/compute cost loops) | SRS declares per-invocation cost/time/iteration caps as invariants (ties to A10). | LLM10:2025 |

### Agentic-AI axis verdict rules
<!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
- If the episode has an agentic surface, `fail` on **prompt injection**,
  **excessive agency**, or **sensitive information disclosure** is always a
  **blocker** — these are the three highest-leverage agentic risks and must be
  declared as §2.3 invariants before the SRS can be accepted.
- The **excessive agency** check doubles as a CGAD no-self-authorization guard
  (R5): if the SRS lets an agent authorize its own completion/retry, that is a
  hard `fail` regardless of any other pass — the architect must rework the
  agency boundary so authorization stays with the controller/verifier.
- Other agentic `fail`s are `changes_requested`; promote to invariant
  violations where the control is a checkable predicate.

---

## How verdicts roll up

Per the SKILL.md "Security review" phase:
1. The reviewer emits one verdict line per OWASP category, per activated ASVS
   chapter, and per agentic threat (if agentic surface present).
2. Any **blocker** verdict → the whole Security review phase returns
   `changes_requested`; the blocker gap(s) are written into the SRS §2.3
   Invariant Registry as missing invariants and listed in the `worker_done`
   `result` body.
3. All `pass` or `N/A` (with justifications) → Security review phase passes;
   the verdict table is appended to the `result` body as evidence.
4. The reviewer never approves the SRS from this phase alone — all other
   review-procedure checks (Complexity Gate, §D, §9/§10/§11/§12) must also
   pass. This phase only adds the security dimension.
