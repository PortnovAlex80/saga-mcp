# 068. Isolate Python readiness with an ephemeral virtualenv

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The first fresh Python canary completed every production cell, integration, and
verification worker, but settled `development-blocked`. The exact Factory-owned
receipt showed that `pip install -r requirements.txt` failed under Debian's PEP
668 externally-managed Python. The implementation itself passed 42 tests only
because its author used `--break-system-packages`; that worker observation is
not acceptance authority.

ADR-053 requires immutable candidate authority, ADR-058 requires independent
local runnability, and the conveyor model requires the execution substrate not
to mutate controller state. The accepted readiness profile remains the sole
authority for command selection.

Cynefin classification: **Complicated**. The failure is deterministic and the
options are analyzable, but choosing the wrong substrate boundary would weaken
polyglot isolation. Subagent generation was not used because the active
repository execution policy forbids new delegation; independent option and
red-team lenses were applied in the primary agent.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Correctness | 25 | The independent gate must execute the exact frozen commands. |
| Isolation | 20 | Candidate dependencies must not enter controller/system Python. |
| Authority alignment | 20 | Environment selection must not replace profile command authority. |
| Testability | 15 | PEP-668 behavior and venv activation need deterministic coverage. |
| Reversibility | 10 | The provider change must remain versioned and removable. |
| Implementation cost | 10 | The canary sequence should resume without a new runtime platform. |

## Considered options

### Option A — ephemeral host virtualenv

When the frozen install command explicitly invokes `pip` or `python -m pip`,
create a virtualenv inside the disposable exact-tree extraction and prepend its
bin directory to PATH for install, test, and serve. Preserve every command
byte-for-byte. Version the provider and record the isolation in evidence.

### Option B — require a Docker image in every Python readiness profile

Make Formalization/Planning always declare a Python image and execute readiness
through the Docker executor. Isolation is strong, but correctness would depend
on an additional LM-authored field and Docker-in-Docker availability. Existing
valid Python contracts would need semantic repair.

### Option C — allow system pip writes

Set `PIP_BREAK_SYSTEM_PACKAGES=1` or append the corresponding CLI flag. This is
cheap, but changes the declared command and permits candidate dependencies to
pollute the controller image.

## MCDA matrix

Scores are 1 (poor) to 5 (excellent).

| Option | correctness (25) | isolation (20) | authority (20) | testability (15) | reversibility (10) | cost (10) | Σ / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Ephemeral venv | 5 | 5 | 5 | 4 | 5 | 4 | 475 |
| B. Mandatory Docker image | 5 | 5 | 4 | 4 | 4 | 2 | 425 |
| C. Break system packages | 2 | 1 | 3 | 3 | 5 | 5 | 275 |

**Sanity check:** A and B both isolate dependencies; A wins because it does not
make an LM-selected image or nested daemon a prerequisite. C fails the primary
isolation driver regardless of its low cost.

## Pre-mortem

Assumption: ephemeral venv isolation was implemented and failed six months later.

1. **Python is unavailable on the host** — likelihood: M; detectable: immediate typed diagnostic; mitigation: fail closed with `LOCAL_RUNNABILITY_PYTHON_VENV_UNAVAILABLE` or use an explicitly declared Docker image.
2. **Serve runs outside the venv** — likelihood: M; detectable: integration test; mitigation: use the same executor environment for install, test, and serve.
3. **Implicit inference expands into build-command guessing** — likelihood: M; detectable: architecture review; mitigation: activate only from an explicit pip install prefix and never alter command text.
4. **Venv state leaks between candidates** — likelihood: L; detectable: temp-path assertions; mitigation: place it below the per-check extraction deleted in `finally`.

**Net effect:** the option survives with all four mitigations included.

## Red Team

**Strongest argument against the leading option:** Automatically creating a
venv is still inference. It can hide a broken product contract and make host
results diverge from production; mandatory Docker images make the environment
fully explicit.

**Source in repo:** ADR-058 and `local-runnability-check-provider.ts` state that
the profile is command authority and the executor chooses only where/how those
commands run.

**Response:** incorporated as a boundary guard. The provider activates the venv
only from the explicit install command, preserves command bytes, records
`python-venv` in evidence, and fails closed if the substrate cannot be created.
An explicit Docker image still overrides the host path.

## Decision

Chose: **ephemeral host virtualenv**.

It best preserves exact command authority and controller isolation while keeping
Docker an explicit stronger substrate. The red-team concern is addressed by a
narrow activation predicate, versioned evidence, and fail-closed behavior.

## Consequences

**Positive:**
- PEP-668 hosts can verify Python products without system mutation.
- Install, test, and serve share one disposable environment.
- Existing npm and JVM behavior is unchanged.

**Negative:**
- Python venv creation adds startup cost to each uncached readiness check.
- Host mode requires a working Python venv module.

**Neutral / follow-ups:**
- A future environment manifest may pin interpreter identity as well as commands.
- Docker profiles remain preferable when exact deployment-image parity is required.

## Decision Journal

**Date:** 2026-08-14
**Decision (one line):** Isolate explicit pip-based host readiness in a disposable venv.

**Ex-ante expectations — IF this decision was right, I expect:**
- In 30 days: Python canaries pass readiness without `--break-system-packages` and without writes outside the temporary extraction.
- In 90 days: no npm/JVM readiness regression and no second Python-specific command rewrite.

**Check trigger:** any host-vs-Docker readiness divergence or another PEP-668 failure.
**What would change my mind:** products require materially different Python runtimes that cannot be represented by the current explicit Docker image field.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-058](058-local-runnability-before-human-acceptance.md)
- [Conveyor mental model](../CONVEYOR-MENTAL-MODEL.md)
