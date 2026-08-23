import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../shared/canonical-json.js';
import { probeLoopbackOnce } from './served-process-runner.js';
import {
  commandFailureDetail,
  type ExecutorDescription,
  type ReadinessExecutor,
  type ServeEvidence,
  ReadinessExecutionError,
} from './readiness-executor.js';

/**
 * Docker readiness executor — prepares one post-install OCI environment, then
 * runs test and serve in independent fresh containers from that exact image.
 *
 * The executor is SYNCHRONOUS (the gate-run-driver rejects async providers).
 * Every docker CLI call goes through execFileSync/spawnSync with bounded
 * timeouts. No dockerode, no daemon API — just the docker CLI, the same way a
 * human runs `docker run`.
 *
 * Tree transfer: the provider extracts the exact git archive into a disposable
 * build context. Docker builds one session-owned image from an exact local tag
 * of the declared base plus the verbatim install command. Test mutations then
 * cannot prepare the separately-created serve container.
 *
 * K19 / ADR-083 §2.1 base image IDENTITY (the image/dependency digest
 * remainder): the AUTHORITATIVE identity of the declared base image is the OCI
 * REGISTRY MANIFEST DIGEST — `sha256:<64hex>` observed from the pulled
 * image's RepoDigests. NEVER the declared (floating) tag, and NEVER the local
 * image id (`docker image inspect {{.Id}}` reports the local config digest;
 * it stays in `resolvedBaseImageId` as PROVENANCE only). An image with no
 * registry provenance (built or loaded locally) has NO registry manifest
 * digest — that is missing identity evidence and fails closed with a typed
 * ENVIRONMENT_IMAGE_IDENTITY_* code BEFORE any build. Identity failures are
 * the declaration's defect (K19 owns identity); they are NOT substrate
 * preconditions — ADR-091/ADR-089 own availability, and a daemon fault during
 * the identity inspect still throws a plain error so the provider's mid-check
 * classifier routes it by OBSERVATION.
 *
 * K19 repair after REJECT (blocker 1) — ATOMIC observation: RepoDigests and
 * the local Id are resolved as PAIRED FACTS from ONE `docker image inspect`
 * snapshot (see resolveBaseImageIdentitySnapshot), and only the immutable Id
 * of that same snapshot is tagged as the session base. Two inspects against
 * the MUTABLE declared tag are forbidden: between them a concurrent
 * pull/tag can re-point the tag from image A to image B, pairing A's
 * manifest digest (the receipt identity) with B's local id (the image
 * actually executed).
 *
 * Fail-closed policy (CC-GAP-9 / ADR-089): when the profile declares an image
 * but docker is unavailable (daemon down, not linux), the executor throws
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE / LOCAL_RUNNABILITY_DOCKER_NOT_LINUX.
 * The provider catches these INSIDE its try block, retries the precondition
 * deterministically up to the frozen in-check bound, and on exhaustion emits
 * the typed unknown outcome (`warrant-blocked-environment`) — never a product
 * `failed`. This is deliberate: the product declared a docker substrate, so
 * the provider refuses to silently fall back to host; and a missing
 * environment precondition is not a product verdict.
 *
 * Mid-check TOCTOU (ADR-091): a daemon that dies AFTER the start-of-check
 * probe passed surfaces as a failing Docker-executor step (pull, build, run,
 * serve) or a failed compose step. The provider does NOT classify such
 * failures from their text: it calls reprobeDockerAvailabilityAfterFailure()
 * and only the OBSERVED result routes (unavailable/not-linux → the ADR-089
 * machinery above; available+linux → the original product `failed`). Stderr is
 * never a classification input. Host-executor steps (the sibling substrate in
 * the provider) have no daemon dependency and are never re-probed.
 */

/**
 * A well-formed OCI digest: the algorithm docker pins for manifests, 64 lowercase hex.
 */
const OCI_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

/** A well-formed local docker image Id (`sha256:<64hex>` — the config digest). */
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/u;

/**
 * Type guard over a value that must be a well-formed OCI digest
 * (`sha256:<64 lowercase hex>`). Exported so the provider boundary can apply
 * the SAME grammar to the `baseImageDigest` a docker executor description
 * presents (K19 repair: one grammar, both sides of the boundary).
 */
export function isWellFormedOciDigest(value: unknown): value is string {
  return typeof value === 'string' && OCI_DIGEST_RE.test(value);
}

/**
 * K19 repair after REJECT (blocker 1) — the ONE atomic identity observation
 * format: a SINGLE `docker image inspect` whose response carries BOTH
 * `.RepoDigests` and `.Id` of ONE image object, separated by one literal
 * tab. The pairing of the two facts inside one response is what makes a
 * tag switch between two resolutions of the MUTABLE declared tag
 * unrepresentable: pre-fix, RepoDigests and Id were read in two separate
 * inspects, so a concurrent `docker pull`/`docker tag` between them paired
 * image A's registry manifest digest (the receipt identity) with image B's
 * local id (the image actually tagged, built FROM and run).
 */
const IMAGE_IDENTITY_SNAPSHOT_FORMAT = '{{json .RepoDigests}}\t{{.Id}}';

/** `docker info` availability probe timeout (bounded so a hung daemon does not stall the gate). */
const DOCKER_INFO_TIMEOUT_MS = 8_000;
/** `docker pull` timeout — matches the install phase budget. */
const DOCKER_PULL_TIMEOUT_MS = 600_000;
/** `docker volume rm` / `docker rm -f` cleanup timeout. */
const DOCKER_RM_TIMEOUT_MS = 30_000;
/** Prepared-image build timeout, including the profile install command. */
const DOCKER_BUILD_TIMEOUT_MS = 600_000;
/** `docker run -d` (served start) timeout. */
const DOCKER_RUN_D_TIMEOUT_MS = 30_000;
/** Container state inspect timeout per poll. */
const DOCKER_INSPECT_TIMEOUT_MS = 5_000;
/** `docker logs` capture timeout. */
const DOCKER_LOGS_TIMEOUT_MS = 10_000;
/** Best-effort capture cap per stream (matches the host served runner). */
const MAX_STREAM_CAPTURE = 16_384;
/** Loopback probe poll interval (matches the host served runner). */
const PROBE_POLL_INTERVAL_MS = 120;
/** Per-attempt HTTP connect/read timeout for one loopback probe shot. */
const PROBE_ATTEMPT_TIMEOUT_MS = 600;

/**
 * Process-level docker availability cache. Probing `docker info` on every
 * command would be wasteful; the daemon state does not change within one
 * readiness check attempt. Invalidated by the provider at the START of every
 * readiness check (CC-GAP-9 follow-up: the FIRST attempt must genuinely
 * re-probe too — a stale positive left by a previous check in the same engine
 * process would mask a down daemon as LOCAL_RUNNABILITY_DOCKER_PULL_FAILED,
 * recreating the Elite-6 failed-for-a-machine-fault shape, and a stale
 * negative would be replayed as attempt-1 evidence without any probe), again
 * between CC-GAP-9 in-check substrate retry attempts, by the ADR-091 mid-check
 * re-probe (every DOCKER-executor/compose step failure invalidates and
 * re-observes before classification — host-executor steps have no daemon
 * dependency and are never re-probed), and by process restart.
 */
let dockerAvailabilityCache: { available: boolean; linux: boolean } | null = null;

/**
 * TEST-ONLY seam for the `docker info` observation (ADR-091): when installed
 * and returning a non-null observation, checkDockerAvailable reports it
 * instead of spawning the docker CLI. This makes the mid-check re-probe
 * CLASSIFICATION hermetically provable — the probe MECHANICS (bounded
 * `docker info`, cache invalidation, typed observation) stay frozen in
 * production code; only the observed RESULT is controllable, exactly like
 * seedDockerAvailabilityCacheForTests controls the cached entry. Production
 * never installs a probe.
 */
let dockerInfoProbeForTests: (() => { available: boolean; linux: boolean } | null) | null = null;

/**
 * Invalidate the process-level docker availability cache. Called by the
 * provider at the start of every readiness check and by its bounded in-check
 * substrate retry between attempts (CC-GAP-9 / ADR-089), and by tests that
 * need a fresh probe.
 */
export function resetDockerAvailabilityCache(): void {
  dockerAvailabilityCache = null;
}

/**
 * Exported for tests: read the cached availability WITHOUT probing. `null`
 * means no cached observation — the next availability check must genuinely
 * probe the daemon. Used by the CC-GAP-9 regression proofs to observe that
 * the provider invalidates the cache before the FIRST attempt of every
 * check, not only between retry attempts.
 */
export function peekDockerAvailabilityCacheForTests(): { available: boolean; linux: boolean } | null {
  return dockerAvailabilityCache;
}

/**
 * Exported for tests: seed the process-level availability cache with an
 * observed result, simulating a STALE entry left by a previous readiness
 * check in the same process. The provider must invalidate it at the start of
 * the next check (see resetDockerAvailabilityCache); the regression proofs
 * seed a stale positive over a genuinely down daemon to prove the Elite-6
 * poisoning shape cannot recur through the cached-first-attempt path.
 */
export function seedDockerAvailabilityCacheForTests(
  observed: { available: boolean; linux: boolean } | null,
): void {
  dockerAvailabilityCache = observed;
}

/**
 * Install/remove the TEST-ONLY `docker info` observation override (ADR-091).
 * Pass null to uninstall. The override sees EVERY genuine probe — the
 * start-of-check probe, the between-attempt probes, and the mid-check
 * re-probe — so tests can script the daemon's observed lifecycle
 * (healthy-at-start, gone-at-failure) without any docker daemon. The bounded
 * probe mechanics themselves are not injectable.
 */
export function installDockerInfoProbeForTests(
  probe: (() => { available: boolean; linux: boolean } | null) | null,
): void {
  dockerInfoProbeForTests = probe;
}

/**
 * TEST-ONLY seam over the docker CLI invocations of the executor's
 * PREPARATION path (K19 repair after REJECT, blocker 1): presence inspect,
 * pull, the ONE identity snapshot inspect, base-tag freeze, prepared-image
 * build and the prepared-image inspect. When installed and returning a
 * non-null result for the given argv, that scripted result substitutes for
 * the real CLI invocation (the call NEVER spawns docker); `null` falls
 * through to the real CLI. Production never installs the seam. This makes
 * the ATOMIC OBSERVATION contract hermetically provable: a test can observe
 * (and count) every reference-resolution inspect the executor makes and
 * script the tag's observed lifecycle (image A on resolution #1, image B on
 * resolution #2 — a tag switch) without any docker daemon or CLI. The
 * observation MECHANICS (one inspect, one snapshot format, typed
 * fail-closed validation, immutable-id tagging) stay frozen in production
 * code; only the CLI responses are scripted.
 */
export interface DockerCliScriptedResult {
  /** Scripted stdout ('' when the invocation prints nothing). */
  readonly stdout?: string;
  /** Scripted stderr (failure detail only). */
  readonly stderr?: string;
  /** Scripted exit status; non-zero makes the invocation fail like the CLI would. */
  readonly status?: number;
}

let dockerCliForTests:
  ((args: readonly string[]) => DockerCliScriptedResult | null) | null = null;

/** Install/remove the TEST-ONLY docker CLI seam. Pass null to uninstall. */
export function installDockerImageCliForTests(
  handler: ((args: readonly string[]) => DockerCliScriptedResult | null) | null,
): void {
  dockerCliForTests = handler;
}

/**
 * Run one docker CLI invocation of the PREPARATION path (see
 * installDockerImageCliForTests). Routes through the TEST-ONLY seam when
 * installed, else spawns the real CLI. Always decodes stdout as utf8.
 */
function execDockerCliPrepare(
  args: readonly string[],
  timeout: number,
  maxBuffer?: number,
): string {
  if (dockerCliForTests !== null) {
    const scripted = dockerCliForTests(args);
    if (scripted !== null) {
      if (scripted.status !== undefined && scripted.status !== 0) {
        throw new Error(
          `command failed (docker ${args.join(' ')})`
            + (scripted.stderr ? `--- stderr ---\n${scripted.stderr.slice(-3000)}` : ''),
        );
      }
      return scripted.stdout ?? '';
    }
  }
  return execFileSync('docker', [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
  });
}

/**
 * Run one docker BUILD invocation of the preparation path through the same
 * TEST-ONLY seam (status/stdout/stderr shape identical to spawnSync).
 */
function spawnDockerBuildPrepare(
  args: readonly string[],
  input: string,
  timeout: number,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  if (dockerCliForTests !== null) {
    const scripted = dockerCliForTests(args);
    if (scripted !== null) {
      return {
        status: scripted.status ?? 0,
        stdout: scripted.stdout ?? '',
        stderr: scripted.stderr ?? '',
      };
    }
  }
  return spawnSync('docker', [...args], {
    input,
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Probe whether the docker daemon is reachable and running a linux runtime.
 * Memoized per readiness-check attempt (invalidated at the start of every
 * check and between in-check substrate retry attempts — see
 * resetDockerAvailabilityCache). Returns { available: false } when the daemon
 * is down, unreachable, or the CLI is absent. Returns { available: true, linux:
 * false } when the daemon is up but the OSType is not linux (e.g. a Windows
 * container runtime) — the executor refuses non-linux because PORT/HOST/CI env
 * conventions and alpine-based tree-copy assume linux.
 */
function checkDockerAvailable(): { available: boolean; linux: boolean } {
  if (dockerAvailabilityCache) return dockerAvailabilityCache;
  let result = { available: false, linux: false };
  const overridden = dockerInfoProbeForTests !== null ? dockerInfoProbeForTests() : null;
  if (overridden !== null) {
    // TEST-ONLY observation override (see installDockerInfoProbeForTests):
    // the mechanics (cache invalidation, typed observation) are production;
    // only the observed result is scripted.
    result = { available: overridden.available, linux: overridden.linux };
  } else {
    try {
      const osType = execFileSync(
        'docker',
        ['info', '--format', '{{.OSType}}'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: DOCKER_INFO_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
        },
      ).trim();
      result = { available: true, linux: osType === 'linux' };
    } catch {
      result = { available: false, linux: false };
    }
  }
  dockerAvailabilityCache = result;
  return result;
}

/**
 * ADR-091 — the mid-check mechanical re-probe. Invalidates the process-level
 * availability cache and re-observes the daemon with the SAME bounded probe
 * (`docker info`, DOCKER_INFO_TIMEOUT_MS). Called by the provider on every
 * executor/compose step failure: the returned OBSERVATION — never the failed
 * command's stderr — is the sole classification input (observed unavailable /
 * not-linux routes the failure into the ADR-089 bounded substrate retry;
 * observed available+linux leaves the original product failure standing). A
 * probe failure observes `unavailable` (fail-closed observation, never an
 * exception path).
 */
export function reprobeDockerAvailabilityAfterFailure(): { available: boolean; linux: boolean } {
  dockerAvailabilityCache = null;
  return checkDockerAvailable();
}

/**
 * Exported for tests: probe docker availability. Tests use this to decide
 * whether to run the docker e2e test or skip it. Returns true only when the
 * daemon is reachable AND running a linux runtime.
 */
export function isDockerAvailableForReadiness(): boolean {
  const docker = checkDockerAvailable();
  return docker.available && docker.linux;
}

/** Block the current thread for `ms` without spinning (Atomics.wait). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin — SharedArrayBuffer unavailable */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Split an image reference (or a RepoDigest repository part) into its
 * normalized repository name and optional digest pin. Normalization mirrors
 * what `docker image inspect` reports in RepoDigests: the implicit registry
 * docker.io collapses away, a bare name gains the `library/` namespace, and
 * fully-qualified foreign registries (ghcr.io/…) keep their host. A tag
 * (a `:` after the last `/`) is stripped — a tag is never identity.
 */
function repositoryOfReference(reference: string): { repository: string; digest: string | null } {
  const at = reference.indexOf('@');
  const digest = at >= 0 ? reference.slice(at + 1) : null;
  const named = (at >= 0 ? reference.slice(0, at) : reference).toLowerCase();
  const lastSlash = named.lastIndexOf('/');
  const lastColon = named.lastIndexOf(':');
  const untagged = lastColon > lastSlash ? named.slice(0, lastColon) : named;
  if (untagged === '') {
    return { repository: untagged, digest };
  }
  const firstSlash = untagged.indexOf('/');
  const host = firstSlash === -1 ? '' : untagged.slice(0, firstSlash);
  const hasHost = host === 'localhost' || host.includes('.') || host.includes(':');
  if (!hasHost) {
    return { repository: untagged.includes('/') ? untagged : `library/${untagged}`, digest };
  }
  if (host === 'docker.io' || host === 'index.docker.io') {
    const rest = untagged.slice(firstSlash + 1);
    return { repository: rest.includes('/') ? rest : `library/${rest}`, digest };
  }
  return { repository: untagged, digest };
}

/**
 * K19 / ADR-083 §2.1 — resolve the AUTHORITATIVE base image identity: the OCI
 * REGISTRY MANIFEST DIGEST observed for the declared reference, from the
 * pulled image's RepoDigests. Pure over the observed evidence — the caller
 * supplies the RepoDigests half of ONE inspect snapshot (see
 * resolveBaseImageIdentitySnapshot), so the authority is hermetically
 * provable.
 *
 * Fail-closed, typed, BEFORE any build (ADR-083 §3 floating-tag prohibition):
 *
 *   - ENVIRONMENT_IMAGE_IDENTITY_MISSING — no RepoDigests at all: the image
 *     exists only locally (built/loaded); it has no registry manifest digest,
 *     and neither the tag nor the local image id may stand in for one;
 *   - ENVIRONMENT_IMAGE_IDENTITY_MALFORMED — the evidence (or a declared
 *     digest pin) is not `repo@sha256:<64hex>`;
 *   - ENVIRONMENT_IMAGE_IDENTITY_REPO_MISMATCH — the evidence names only
 *     OTHER repositories: substituted evidence for the declared reference;
 *   - ENVIRONMENT_IMAGE_IDENTITY_AMBIGUOUS — divergent digests recorded for
 *     the declared repository (stale/multi-pull history): identity is never
 *     a pick-one guess;
 *   - ENVIRONMENT_IMAGE_IDENTITY_PIN_MISMATCH — the reference was pinned to
 *     a digest and the registry observed DIFFERENT content under it
 *     (substitution under a pin).
 *
 * These are identity verdicts, not substrate preconditions: K19 owns identity,
 * ADR-091/ADR-089 own availability (ADR-083 §6 split), so none of these codes
 * enters the ADR-089 bounded substrate retry.
 */
export function resolveRegistryManifestDigest(
  imageReference: string,
  repoDigests: unknown,
): string {
  const declared = repositoryOfReference(imageReference);
  const malformed = (detail: string): ReadinessExecutionError => new ReadinessExecutionError(
    'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED',
    `the registry manifest digest evidence for the declared image "${imageReference}" is malformed: ${detail}. Expected RepoDigests entries of the form <repository>@sha256:<64 hex>.`,
  );
  if (declared.digest !== null && !OCI_DIGEST_RE.test(declared.digest)) {
    throw malformed(
      `the reference pins "${declared.digest}", which is not a well-formed OCI digest`,
    );
  }
  if (!Array.isArray(repoDigests)) {
    throw malformed('the RepoDigests observation is not an array');
  }
  const observed: Array<{ repository: string; digest: string }> = [];
  for (const entry of repoDigests) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw malformed(`entry ${JSON.stringify(entry)}`);
    }
    const at = entry.indexOf('@');
    if (at <= 0 || at === entry.length - 1) {
      throw malformed(`entry "${entry}" carries no <repository>@<digest> split`);
    }
    const digest = entry.slice(at + 1);
    if (!OCI_DIGEST_RE.test(digest)) {
      throw malformed(`entry "${entry}" does not end in a well-formed sha256 digest`);
    }
    observed.push({ repository: repositoryOfReference(entry.slice(0, at)).repository, digest });
  }
  const matches = observed.filter(entry => entry.repository === declared.repository);
  if (matches.length === 0) {
    if (observed.length === 0) {
      throw new ReadinessExecutionError(
        'ENVIRONMENT_IMAGE_IDENTITY_MISSING',
        `the declared image "${imageReference}" has NO registry manifest digest (RepoDigests is empty — a locally built or loaded image). The floating tag and the local image id are NOT environment identity (ADR-083 §2.1/§3); pull the image from its registry or declare a digest-pinned reference, then re-run.`,
      );
    }
    throw new ReadinessExecutionError(
      'ENVIRONMENT_IMAGE_IDENTITY_REPO_MISMATCH',
      `the registry digest evidence for the declared image "${imageReference}" names only other repositories (${observed.map(entry => entry.repository).sort().join(', ')}); evidence substituted for the declared reference fails closed.`,
    );
  }
  const distinct = [...new Set(matches.map(entry => entry.digest))];
  if (distinct.length > 1) {
    throw new ReadinessExecutionError(
      'ENVIRONMENT_IMAGE_IDENTITY_AMBIGUOUS',
      `the declared image "${imageReference}" carries divergent registry manifest digests (${distinct.sort().join(', ')}); stale or ambiguous identity evidence fails closed — re-pull the exact reference.`,
    );
  }
  const resolved = distinct[0]!;
  if (declared.digest !== null && declared.digest !== resolved) {
    throw new ReadinessExecutionError(
      'ENVIRONMENT_IMAGE_IDENTITY_PIN_MISMATCH',
      `the declared image reference pins ${declared.digest} but the registry manifest digest observed for it is ${resolved}; content substituted under a pinned digest fails closed.`,
    );
  }
  return resolved;
}

/** The paired base-image identity facts derived from ONE inspect snapshot. */
export interface BaseImageIdentitySnapshot {
  /**
   * The AUTHORITATIVE identity (K19 / ADR-083 §2.1): the OCI registry
   * manifest digest of the observed image object.
   */
  readonly baseImageDigest: string;
  /**
   * The local image id of the SAME observed image object. PROVENANCE ONLY —
   * never environment identity; it is what the session base tag freezes.
   */
  readonly resolvedBaseImageId: string;
}

/**
 * K19 repair after REJECT (blocker 1) — resolve the base-image identity as
 * PAIRED FACTS from ONE `docker image inspect` snapshot. The caller supplies
 * the raw stdout of the single inspect (format
 * {@link IMAGE_IDENTITY_SNAPSHOT_FORMAT}); BOTH the registry manifest digest
 * and the local image id derive from that ONE response, so a tag switch
 * between two resolutions of the mutable declared tag can never split the
 * receipt identity from the image actually executed.
 *
 * Fail-closed, typed, BEFORE any build:
 *
 *   - RepoDigests validation rides through resolveRegistryManifestDigest
 *     (ENVIRONMENT_IMAGE_IDENTITY_MISSING / _MALFORMED / _REPO_MISMATCH /
 *     _AMBIGUOUS / _PIN_MISMATCH) — including a RepoDigests half that does
 *     not parse as JSON (malformed evidence, never an untyped crash);
 *   - the Id half must be a well-formed local image id (`sha256:<64hex>`),
 *     one object only — otherwise
 *     LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED (the declared
 *     reference cannot be frozen to one local image).
 *
 * Identity verdicts only: a CLI fault OBSERVING the snapshot is the CALLER's
 * concern and stays a plain error there (ADR-091 routes it by observation).
 */
export function resolveBaseImageIdentitySnapshot(
  imageReference: string,
  inspectOutput: string,
): BaseImageIdentitySnapshot {
  const resolutionFailure = (detail: string): ReadinessExecutionError => new ReadinessExecutionError(
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
    `could not freeze declared image "${imageReference}" from one inspect snapshot: ${detail}. `
      + `Expected exactly one line '<RepoDigests json>\\t<Id>' from --format '${IMAGE_IDENTITY_SNAPSHOT_FORMAT.replace('\t', '\\t')}'.`,
  );
  const trimmed = inspectOutput.trim();
  if (trimmed === '') {
    throw resolutionFailure('the snapshot response is empty');
  }
  const tab = trimmed.indexOf('\t');
  if (tab < 0) {
    throw resolutionFailure('the snapshot carries no <RepoDigests>\\t<Id> split');
  }
  const repoDigestsJson = trimmed.slice(0, tab);
  const id = trimmed.slice(tab + 1).trim();
  if (id === '' || !IMAGE_ID_RE.test(id)) {
    if (id.includes('\n') || trimmed.slice(tab + 1).includes('\t')) {
      throw resolutionFailure(
        'the snapshot matched multiple image objects (a multi-line response) — ambiguity never resolves to a pick-one guess',
      );
    }
    throw resolutionFailure(`the snapshot's local image Id half (${JSON.stringify(id)}) is not a well-formed sha256:<64hex> image id`);
  }
  let repoDigests: unknown;
  try {
    repoDigests = JSON.parse(repoDigestsJson) as unknown;
  } catch (error) {
    throw new ReadinessExecutionError(
      'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED',
      `the registry manifest digest evidence for the declared image "${imageReference}" is malformed: the snapshot's RepoDigests half is not JSON (${error instanceof Error ? error.message : String(error)}). Expected a JSON array of <repository>@sha256:<64 hex> entries.`,
    );
  }
  return {
    baseImageDigest: resolveRegistryManifestDigest(imageReference, repoDigests),
    resolvedBaseImageId: id,
  };
}

export class DockerReadinessExecutor implements ReadinessExecutor {
  private readonly sessionId = randomBytes(8).toString('hex');
  private readonly preparedTag: string;
  private readonly baseTag: string;
  private readonly servedContainerName: string;
  private preparedImageId: string | null = null;
  private resolvedBaseImageId: string | null = null;
  /**
   * The AUTHORITATIVE base image identity (K19 / ADR-083 §2.1): the OCI
   * registry manifest digest resolved from RepoDigests. Null only before
   * prepare(); prepare() fails closed typed rather than leaving it null.
   */
  private baseImageDigest: string | null = null;

  constructor(
    private readonly contextDirectory: string,
    private readonly image: string,
  ) {
    this.preparedTag = `saga-lr-prepared:${this.sessionId}`;
    this.baseTag = `saga-lr-base:${this.sessionId}`;
    this.servedContainerName = `saga-lr-serve-${this.sessionId}`;
  }

  /**
   * Lazily prepare the docker substrate: verify the daemon, ensure the image is
   * present (pull if needed), create the volume, and stream the sealed tree tar
   * into it. Idempotent — the second call is a no-op. Throws
   * ReadinessExecutionError on any substrate-level failure: the two
   * environment-precondition codes (daemon down / not linux) carry the
   * CC-GAP-9 in-check retry and, on exhaustion, the typed unknown
   * `warrant-blocked-environment` outcome in the provider; every other code
   * records a decodable 'failed' outcome as before.
   */
  private ensureDockerAvailable(): void {
    // 1. Daemon availability + linux runtime.
    const docker = checkDockerAvailable();
    if (!docker.available) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
        'environment.image is declared but the docker daemon is not available '
          + '(docker info failed within 8s). The readiness profile declares a '
          + 'containerized substrate; refusing to fall back to host (fail closed). '
          + 'Start Docker Desktop / the docker daemon and re-run.',
      );
    }
    if (!docker.linux) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX',
        'environment.image is declared but the docker daemon OSType is not linux '
          + '(only linux containers are supported). The readiness profile declares '
          + 'a containerized linux substrate; refusing to run on a non-linux runtime.',
      );
    }
    // Ensure the declared image is present locally (pull if absent).
    this.ensureImagePulled();
  }

  private ensureImagePulled(): void {
    try {
      execDockerCliPrepare(['image', 'inspect', this.image], DOCKER_INFO_TIMEOUT_MS);
      return; // image already present locally
    } catch {
      // not found → fall through to pull
    }
    try {
      execDockerCliPrepare(['pull', this.image], DOCKER_PULL_TIMEOUT_MS, 8 * 1024 * 1024);
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED',
        `docker image pull failed for "${this.image}": `
          + commandFailureDetail('docker pull', [this.image], error),
      );
    }
  }

  prepare(installCommand: string | null, timeoutMs: number): void {
    if (this.preparedImageId !== null) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PREPARE_REPLAY',
        'the Docker readiness environment was prepared more than once',
      );
    }
    this.ensureDockerAvailable();
    // K19 repair after REJECT (blocker 1) / ADR-083 §2.1 — resolve the
    // base-image identity from ONE ATOMIC `docker image inspect` snapshot
    // BEFORE any build cost: RepoDigests (the authoritative OCI REGISTRY
    // MANIFEST DIGEST) and the local Id are PAIRED FACTS of the SAME
    // response, never two inspects against the MUTABLE declared tag — a
    // tag switch between two resolutions (concurrent pull/tag: image A →
    // image B) cannot pair A's manifest digest with B's local id. A daemon
    // fault here (inspect fails) throws a PLAIN error so the provider's
    // ADR-091 mid-check classifier routes it by observation — an identity
    // verdict is only ever made over successfully observed evidence.
    let snapshotOutput: string;
    try {
      snapshotOutput = execDockerCliPrepare(
        ['image', 'inspect', '--format', IMAGE_IDENTITY_SNAPSHOT_FORMAT, this.image],
        DOCKER_INFO_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(commandFailureDetail(
        'docker image inspect',
        ['--format', IMAGE_IDENTITY_SNAPSHOT_FORMAT.replace('\t', '\\t'), this.image],
        error,
      ));
    }
    const snapshot = resolveBaseImageIdentitySnapshot(this.image, snapshotOutput);
    this.baseImageDigest = snapshot.baseImageDigest;
    this.resolvedBaseImageId = snapshot.resolvedBaseImageId;
    // Freeze the base by tagging ONLY the immutable Id from that same
    // snapshot — never the mutable declared tag again. The prepared image
    // is built FROM this frozen local id, so the executed environment and
    // the recorded identity are facts of ONE image object.
    try {
      execDockerCliPrepare(['tag', this.resolvedBaseImageId, this.baseTag], 30_000);
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
        `could not freeze declared image "${this.image}" to a local image identity: ${errorMessage(error)}`,
      );
    }
    const dockerfile = [
      `FROM ${this.baseTag}`,
      'WORKDIR /work',
      'COPY . /work',
      ...(installCommand === null
        ? []
        : [`RUN ["sh", "-c", ${JSON.stringify(installCommand)}]`]),
      '',
    ].join('\n');
    const result = spawnDockerBuildPrepare(
      [
        'build', '--quiet', '--file', '-', '--tag', this.preparedTag,
        '--label', `saga.readiness.session=${this.sessionId}`,
        this.contextDirectory,
      ],
      dockerfile,
      Math.max(timeoutMs, DOCKER_BUILD_TIMEOUT_MS),
    );
    if (result.status !== 0) {
      throw new Error(
        commandFailureDetail('docker build', [installCommand ?? '<no-install>'], {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.error && (result.error as NodeJS.ErrnoException).code,
          message: result.error?.message,
        }),
      );
    }
    try {
      this.preparedImageId = execDockerCliPrepare(
        ['image', 'inspect', '--format', '{{.Id}}', this.preparedTag],
        DOCKER_INFO_TIMEOUT_MS,
      ).trim();
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PREPARED_IMAGE_MISSING',
        `Docker build completed without an inspectable prepared image: ${errorMessage(error)}`,
      );
    }
  }

  runCommand(command: string, timeoutMs: number): void {
    const preparedImage = this.requirePreparedImage();
    // The command runs verbatim via `sh -c` inside the container. No npm/node
    // routing, no ./ stripping, no JVM env — the image IS the environment. CI=1
    // matches the host executor's convention so the product's test command
    // behaves the same in both substrates.
    try {
      execFileSync('docker', [
        'run', '--rm',
        '-w', '/work',
        '-e', 'CI=1',
        preparedImage,
        'sh', '-c', command,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run ${preparedImage} sh -c`,
        [command],
        error,
      ));
    }
  }

  runServed(startCommand: string, probeTimeoutMs: number, port: number): ServeEvidence {
    const preparedImage = this.requirePreparedImage();
    const containerName = this.servedContainerName;
    this.removeContainer(containerName);
    // Start the serve command detached. The port is published to 127.0.0.1 so
    // the host-side loopback probe can reach it. HOST=0.0.0.0 tells the product
    // to bind all interfaces inside the container (binding 127.0.0.1 inside the
    // container would be unreachable from the host-published port).
    try {
      // docker run -d prints the container id to stdout; we track the container
      // by its deterministic name (for inspect/rm) rather than the id.
      execFileSync('docker', [
        'run', '-d',
        '--name', containerName,
        '--label', `saga.readiness.session=${this.sessionId}`,
        '-p', `127.0.0.1:${port}:${port}`,
        '-w', '/work',
        '-e', `PORT=${port}`,
        '-e', 'HOST=0.0.0.0',
        '-e', 'CI=1',
        preparedImage,
        'sh', '-c', startCommand,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RUN_D_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run -d ${preparedImage} sh -c`,
        [startCommand],
        error,
      ));
    }
    try {
      // Observe: poll the container state + host-side loopback probe until the
      // endpoint answers, the deadline elapses, or the container exits.
      this.observeContainerReady(containerName, port, probeTimeoutMs);
      // Capture logs for evidence digests (best-effort, capped).
      const { stdout, stderr } = this.captureLogs(containerName);
      return {
        port,
        stdoutDigest: sha256Hex(stdout),
        stderrDigest: sha256Hex(stderr),
      };
    } finally {
      // RELIABLE TERMINATION — the container is always removed (force) in a
      // finally that runs on success, probe-timeout, and container-exit.
      this.removeContainer(containerName);
    }
  }

  describe(): ExecutorDescription {
    return {
      substrate: 'docker',
      image: this.image,
      // The AUTHORITATIVE identity (K19 / ADR-083 §2.1): the OCI registry
      // manifest digest. The local image id below is PROVENANCE only.
      ...(this.baseImageDigest !== null ? { baseImageDigest: this.baseImageDigest } : {}),
      ...(this.resolvedBaseImageId ? { resolvedImageId: this.resolvedBaseImageId } : {}),
      phaseModel: 'prepared-oci-image',
    };
  }

  dispose(): void {
    this.removeContainer(this.servedContainerName);
    this.removeImage(this.preparedTag);
    this.removeImage(this.baseTag);
    this.preparedImageId = null;
    this.resolvedBaseImageId = null;
    this.baseImageDigest = null;
  }

  private requirePreparedImage(): string {
    if (this.preparedImageId === null) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_NOT_PREPARED',
        'Docker readiness test/serve was invoked before environment preparation',
      );
    }
    return this.preparedImageId;
  }

  /**
   * Poll the container state and the host-side loopback probe until the endpoint
   * answers, the deadline elapses, or the container exits before answering.
   * Mirrors the host served runner's observeUntilReady, but uses `docker inspect`
   * for liveness (the pid is inside the container namespace and not directly
   * killable/observable from the host).
   */
  private observeContainerReady(
    containerName: string,
    port: number,
    deadlineMs: number,
  ): void {
    const url = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const state = this.inspectContainer(containerName);
      if (state !== null && state.status !== 'running' && state.status !== 'created') {
        // The container exited (or is in a terminal state) before answering.
        throw new Error(
          `served container "${containerName}" exited before answering on loopback `
            + `(state=${state.status}, exitCode=${state.exitCode})`,
        );
      }
      if (probeLoopbackOnce(url, PROBE_ATTEMPT_TIMEOUT_MS)) {
        return; // endpoint is answering on loopback
      }
      if (Date.now() >= deadline) {
        // Final attribution: a container that died on the last attempt is
        // reported as exited rather than a plain timeout.
        const finalState = this.inspectContainer(containerName);
        if (finalState !== null && finalState.status !== 'running' && finalState.status !== 'created') {
          throw new Error(
            `served container "${containerName}" exited during loopback probe `
              + `(state=${finalState.status}, exitCode=${finalState.exitCode})`,
          );
        }
        throw new Error(
          `loopback readiness probe timed out after ${deadlineMs}ms `
          + `(container="${containerName}", port=${port}); the served command `
          + 'must bind the Factory-provided PORT environment variable',
        );
      }
      sleepSync(PROBE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Inspect the container's runtime state via `docker inspect`. Returns null
   * when the container is absent or the inspect fails (treated as "unknown, keep
   * polling" — the deadline is the hard outer guarantee).
   */
  private inspectContainer(containerName: string): { status: string; exitCode: number } | null {
    try {
      const output = execFileSync(
        'docker',
        ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerName],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: DOCKER_INSPECT_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
        },
      ).trim();
      const parts = output.split(/\s+/u);
      const status = parts[0] ?? 'unknown';
      const exitCode = Number.parseInt(parts[1] ?? '-1', 10);
      return { status, exitCode: Number.isFinite(exitCode) ? exitCode : -1 };
    } catch {
      return null;
    }
  }

  /**
   * Capture the container's stdout/stderr logs for evidence digests. Uses
   * spawnSync so both streams are captured separately. Best-effort, capped at
   * MAX_STREAM_CAPTURE per stream (matches the host served runner).
   */
  private captureLogs(containerName: string): { stdout: string; stderr: string } {
    try {
      const result = spawnSync('docker', ['logs', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_LOGS_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: MAX_STREAM_CAPTURE,
      });
      const stdout = typeof result.stdout === 'string'
        ? result.stdout.slice(0, MAX_STREAM_CAPTURE) : '';
      const stderr = typeof result.stderr === 'string'
        ? result.stderr.slice(0, MAX_STREAM_CAPTURE) : '';
      return { stdout, stderr };
    } catch {
      return { stdout: '', stderr: '' };
    }
  }

  /**
   * Force-remove a container by name (idempotent — a missing container is not
   * an error). Used for pre-run collision cleanup and post-run termination.
   */
  private removeContainer(containerName: string): void {
    try {
      execFileSync('docker', ['rm', '-f', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RM_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // A missing container is expected on the pre-run cleanup and after a
      // container that exited on its own. Swallow — the observe/terminate
      // logic above already detected the real failure mode.
    }
  }

  /** Remove only an image tag owned by this readiness session. */
  private removeImage(imageRef: string): void {
    try {
      execFileSync('docker', ['image', 'rm', '-f', imageRef], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RM_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup; tags are random and session-owned.
    }
  }
}
