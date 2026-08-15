# ADR-071: Readiness Prepares One OCI Environment

- **Status:** Accepted
- **Date:** 2026-08-15
- **Decision-maker:** autonomous-decision skill

## Context

The first real Python canary through ADR-070 reached the new readiness
certification Cell. Its accepted manifest declared a Python base image, an
install command, a test command and a serve command. The Docker executor ran
each phase in a new container from the raw base image and shared only `/work`.
Consequently a successful `pip install` disappeared before test and serve.
The model eventually repeated installation inside the test command, so tests
passed, but the fresh serve container still exited without Flask.

The readiness contract is sequential: install prepares one environment, test
observes it, and serve proves that the same prepared product can answer on
loopback. The physical executor must conserve that contract without
language-specific cache or package-path knowledge. Cynefin classification:
**Complicated**.

## Considered options and MCDA

Scores use 1 (poor) through 5 (excellent).

| Driver | Weight | One mutable session | Prepared OCI image | Repeat install per phase |
|---|---:|---:|---:|---:|
| authority correctness | 30 | 5 | 5 | 3 |
| existing-contract alignment | 20 | 5 | 4 | 3 |
| phase isolation/reproducibility | 15 | 3 | 5 | 5 |
| testability | 15 | 4 | 4 | 5 |
| implementation cost | 10 | 4 | 2 | 5 |
| reversibility | 10 | 5 | 4 | 5 |
| **weighted total / 500** | | **445** | **425** | **400** |

1. **One mutable session container.** Install, test and serve use `docker
   exec` in one container. This is the smallest generic repair and matches the
   current host executor's lifetime.
2. **Prepared OCI environment.** Build one disposable derived image from the
   exact sealed tree, exact resolved base image and exact install command. Test
   and serve run in separate fresh containers from that prepared image.
3. **Repeat install in each fresh container.** Prepend the exact install command
   to both test and serve. This is small but can resolve different network
   dependencies twice and requires installation to be repeatable.

## Pre-mortem on the initial leader

Assumption: the one-session option was implemented and failed later.

1. Tests generated assets, migrated state or installed an undeclared package;
   serve then passed only because it observed test mutations. Likelihood:
   medium; detectable only with a deliberate isolation adversary; mitigation:
   snapshot the post-install environment before test.
2. Concurrent checks for one candidate removed each other's deterministic
   container. Likelihood: low; detectable by concurrency tests; mitigation:
   per-check ownership labels and random physical names.
3. Detached `docker exec` output/status markers misclassified an early server
   exit. Likelihood: medium; detectable by injected exit tests; mitigation:
   fresh served containers with native Docker state/log observation.
4. Cleanup left mutable sessions consuming disk or executing after timeout.
   Likelihood: medium; detectable by resource inventory; mitigation: labeled
   resources and unconditional bounded cleanup.

The first failure is an acceptance-authority defect, not operational hardening:
test is evidence, not an undeclared preparation phase.

## Red Team

Red Team rejected the numeric leader. A mutable post-test filesystem is not a
pinned environment and can make a broken service appear runnable. The repo's
Gate contract requires evidence reproducible from the pinned candidate,
parameters and environment; the post-test root filesystem satisfies none of
those coordinates. Snapshotting after install repairs the defect and is the
prepared-image option. Repeating install preserves isolation but can give test
and serve different environments. The objection is accepted.

## Decision

For a Docker readiness profile, resolve the declared base image once, build one
disposable prepared OCI image from the exact git-archive tree and exact
`installCommand`, then execute `testCommand` and `serve.startCommand` in
separate fresh containers from that exact prepared image.

The Factory changes the substrate, not command authority: profile command
bytes remain exact. A null install command still creates a prepared image so
test and serve share one frozen source/base coordinate. Test mutations cannot
flow into serve. Physical container/tag names are audit-only and never enter
candidate or Gate authority.

## Load-bearing invariants

1. Candidate commit/tree, readiness manifest, resolved base image identity and
   install-command digest identify one preparation attempt.
2. Test and serve both use the exact prepared image returned by that attempt,
   never the mutable base tag.
3. Install failure prevents test and serve; test failure prevents serve.
4. Test and serve receive independent writable container layers; test effects
   cannot prepare serve.
5. No generated build-control file or dependency output mutates the canonical
   repository or sealed tree.
6. Every exit path attempts to remove only resources bearing the current
   check's ownership label. Cleanup failure is a bounded janitorial anomaly; it
   cannot change the check verdict or fabricate a passed receipt.
7. The provider version/digest changes, so receipts from the old phase model
   cannot replay as evidence for the new one.

## Consequences

Positive: Python, npm, Gradle and future toolchains receive generic install
continuity without cache-path heuristics; test/serve isolation prevents a false
green; Docker state/logs remain native and observable.

Negative: each readiness check performs an image build and consumes temporary
daemon cache/disk. Mutable network installs remain as reproducible as the
accepted command and package locks permit. Images must provide POSIX `sh`, as
the existing executor already requires.

No DB or product-schema migration is required. The implementation is a pinned
provider-version change and is reversible by module/provider selection.

## Required evidence

- A local Python package installed outside `/work` is importable in both test
  and serve without repeating installation.
- Test writes a root/worktree marker and serve proves it is absent.
- Changed base identity, source tree or install command changes preparation
  evidence and cannot reuse an old receipt.
- Install/test failure, server early exit, probe timeout and concurrent checks
  leave no owned containers/images and never emit passed evidence.
- Existing host/venv and Docker-unavailable fail-closed tests remain green.
- A fresh scripted Docker E2E and sequential Python, TypeScript and Kotlin real
  canaries pass.

## Decision Journal

**Date:** 2026-08-15

**Decision:** Freeze one post-install OCI environment, then isolate test and
serve from each other.

**Ex-ante expectations:**

- In 30 days, no readiness failure attributes a missing dependency to a phase
  boundary after a successful install.
- In 90 days, no provider change introduces language-specific dependency/cache
  paths into Docker readiness.
- Every Docker readiness test run leaves zero session-owned containers and
  tagged prepared images.

**Check trigger:** any canary where install succeeds but a later phase cannot
see the installed dependency, or where serve passes only after a test mutation.

**What would change my mind:** evidence that prepared-image build cost prevents
bounded Factory throughput even with local layer caching and resource cleanup.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-058](058-local-runnability-before-human-acceptance.md)
- [ADR-068](068-isolate-python-readiness-with-ephemeral-venv.md)
- [ADR-070](070-post-integration-readiness-certification-cell.md)
