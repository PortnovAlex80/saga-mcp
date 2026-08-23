// tests/infrastructure/environment-image-observation.test.mjs
//
// K19 repair after REJECT — blocker 1: ATOMIC base image observation
// (ADR-083 §2.1). The pre-fix DockerReadinessExecutor.prepare read
// RepoDigests and Id in TWO `docker image inspect` calls against the
// MUTABLE declared tag. Between the two calls the tag can be re-pointed
// from image A to image B (a concurrent pull/tag): pre-fix pairing then
// bound A's registry manifest digest (identity, on the receipt) to B's
// local image id (the image actually tagged, built FROM and run) — a
// receipt that certifies an environment that never ran.
//
// The contract under test:
//
//   - ONE `docker image inspect` snapshot (a single --format asking for
//     BOTH `.RepoDigests` and `.Id`) resolves ONE image object;
//   - BOTH facts are validated fail-closed from that ONE response:
//     RepoDigests through the typed ENVIRONMENT_IMAGE_IDENTITY_* battery,
//     the local Id as a well-formed docker image id
//     (LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED otherwise);
//   - baseImageDigest and resolvedBaseImageId are PAIRED — derived from
//     the same response, so a tag switch between two resolutions can
//     never split them;
//   - the session base tag freezes ONLY the immutable Id from that same
//     snapshot (never the mutable declared tag again).
//
// RED (pre-implementation, exact semantic reasons): the paired-facts
// authority (resolveBaseImageIdentitySnapshot) and the prepare-path
// TEST-ONLY docker CLI seam do not exist, so both the pure battery and
// the hermetic prepare proof fail on missing exports; the behavioral
// mismatch proof (A's digest paired with B's id) is re-proven after the
// fix by the recorded two-call-split mutation below.
//
// Hermeticity: the daemon OBSERVATION is scripted through the existing
// installDockerInfoProbeForTests seam; every docker CLI invocation of the
// PREPARE path is scripted through installDockerImageCliForTests. No
// docker daemon, no docker CLI, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as dockerExecutorModule from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import { ReadinessExecutionError } from '../../dist/infrastructure/verification/readiness-executor.js';

const IMAGE = 'node:20-alpine';
const MANIFEST_A = `sha256:${'a'.repeat(64)}`;
const MANIFEST_B = `sha256:${'b'.repeat(64)}`;
const ID_A = `sha256:${'1'.repeat(64)}`;
const ID_B = `sha256:${'2'.repeat(64)}`;
const PREPARED_ID = `sha256:${'f'.repeat(64)}`;

/** Assert a typed ReadinessExecutionError code (the code, not the prose). */
function assertTypedCode(fn, code) {
  assert.throws(
    fn,
    error => error instanceof ReadinessExecutionError && error.code === code,
    `expected the typed failure ${code}`,
  );
}

// ---------------------------------------------------------------------------
// The paired-facts authority: one snapshot response → one identity pair.
// Pure battery over the exported resolver.
// ---------------------------------------------------------------------------

test('K19 atomic observation: the paired-facts authority exists — resolveBaseImageIdentitySnapshot is exported', () => {
  assert.equal(typeof dockerExecutorModule.resolveBaseImageIdentitySnapshot, 'function',
    'the executor exports the one-snapshot identity resolver (RepoDigests AND Id from ONE response)');
});

test('K19 atomic observation: RepoDigests and Id resolve as PAIRED facts from ONE snapshot response', () => {
  const resolve = dockerExecutorModule.resolveBaseImageIdentitySnapshot;
  const snapshot = resolve(IMAGE, `["node@${MANIFEST_A}"]\t${ID_A}`);
  assert.equal(snapshot.baseImageDigest, MANIFEST_A,
    'the registry manifest digest comes from the snapshot RepoDigests');
  assert.equal(snapshot.resolvedBaseImageId, ID_A,
    'the local image id comes from the SAME snapshot — never a second inspect');
  // Reference normalization rides through the same single snapshot.
  const ghcr = resolve('ghcr.io/acme/app:1.2.3', `["ghcr.io/acme/app@${MANIFEST_B}"]\t${ID_B}`);
  assert.equal(ghcr.baseImageDigest, MANIFEST_B);
  assert.equal(ghcr.resolvedBaseImageId, ID_B);
});

test('K19 atomic observation fail-closed: BOTH facts of the one snapshot are validated — a missing digest or a malformed id never yields a pair', () => {
  const resolve = dockerExecutorModule.resolveBaseImageIdentitySnapshot;
  // RepoDigests validation rides through (typed identity battery):
  assertTypedCode(
    () => resolve(IMAGE, `[]\t${ID_A}`),
    'ENVIRONMENT_IMAGE_IDENTITY_MISSING',
  );
  assertTypedCode(
    () => resolve(IMAGE, `["other-repo@${MANIFEST_A}"]\t${ID_A}`),
    'ENVIRONMENT_IMAGE_IDENTITY_REPO_MISMATCH',
  );
  assertTypedCode(
    () => resolve(IMAGE, `["node@${MANIFEST_A}", "node@${MANIFEST_B}"]\t${ID_A}`),
    'ENVIRONMENT_IMAGE_IDENTITY_AMBIGUOUS',
  );
  // The local id half of the SAME snapshot fails closed typed too:
  assertTypedCode(
    () => resolve(IMAGE, `["node@${MANIFEST_A}"]\t`),
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
  );
  assertTypedCode(
    () => resolve(IMAGE, `["node@${MANIFEST_A}"]\tnot-an-image-id`),
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
  );
});

test('K19 atomic observation fail-closed: a snapshot that is not one <RepoDigests>\\t<Id> line never yields a pair', () => {
  const resolve = dockerExecutorModule.resolveBaseImageIdentitySnapshot;
  assertTypedCode(
    () => resolve(IMAGE, ''),
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
  );
  assertTypedCode(
    () => resolve(IMAGE, `["node@${MANIFEST_A}"] ${ID_A}`),
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
  );
  // A multi-object inspect response (the reference matched several images)
  // is ambiguity, never a pick-one guess:
  assertTypedCode(
    () => resolve(IMAGE, `["node@${MANIFEST_A}"]\t${ID_A}\n["node@${MANIFEST_B}"]\t${ID_B}`),
    'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
  );
  // RepoDigests that do not parse as JSON keep the typed identity
  // vocabulary (malformed evidence, never an untyped crash):
  assertTypedCode(
    () => resolve(IMAGE, `not-json\t${ID_A}`),
    'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED',
  );
});

// ---------------------------------------------------------------------------
// The hermetic prepare proof: ONE reference-resolution call, paired facts,
// immutable-id tag. The tag switch A→B is modeled at the resolution
// boundary: successive identity resolutions of the SAME mutable declared
// tag return DIFFERENT image objects — exactly what a concurrent
// pull/tag does between two inspects.
// ---------------------------------------------------------------------------

test('K19 atomic observation: prepare resolves the declared image through ONE reference-resolution inspect — paired facts, immutable-id tag, tag switch A→B cannot split them', () => {
  const {
    DockerReadinessExecutor,
    installDockerImageCliForTests,
    installDockerInfoProbeForTests,
    resetDockerAvailabilityCache,
  } = dockerExecutorModule;
  assert.equal(typeof installDockerImageCliForTests, 'function',
    'the TEST-ONLY docker CLI seam exists — the prepare-path observations are hermetically provable');

  const identityInspects = [];
  const tagCalls = [];
  // The observed lifecycle of the MUTABLE declared tag: resolution #1 sees
  // image A; resolution #2 (if any implementation ever makes one) sees the
  // tag re-pointed at image B. A two-inspect implementation consumes both
  // and pairs A's digest with B's id — the pre-fix defect.
  const tagTimeline = [
    { manifest: MANIFEST_A, id: ID_A },
    { manifest: MANIFEST_B, id: ID_B },
  ];
  let resolution = 0;

  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  installDockerImageCliForTests(args => {
    const [head, sub, flag, format, target] = args;
    if (head === 'image' && sub === 'inspect') {
      if (flag === '--format'
          && (String(format).includes('.RepoDigests') || String(format).includes('.Id'))
          && target === IMAGE) {
        // A REFERENCE-RESOLUTION call on the mutable declared tag: it
        // consumes one observation of the tag timeline.
        identityInspects.push({ format: String(format), target });
        const observed = tagTimeline[Math.min(resolution, tagTimeline.length - 1)];
        resolution += 1;
        if (String(format).includes('.RepoDigests') && String(format).includes('.Id')) {
          // The ONE-snapshot shape: both facts from this single response.
          return { stdout: `["node@${observed.manifest}"]\t${observed.id}` };
        }
        // The pre-fix single-field shapes: each is its OWN resolution of
        // the mutable tag — the exact seam where A and B split.
        return String(format).includes('.RepoDigests')
          ? { stdout: `["node@${observed.manifest}"]` }
          : { stdout: observed.id };
      }
      // The prepared-image inspect ({{.Id}} on the session-owned tag): one
      // deterministic response.
      return { stdout: PREPARED_ID };
    }
    if (head === 'tag') {
      tagCalls.push([...args]);
      return { stdout: '' };
    }
    if (head === 'build') {
      return { status: 0, stdout: '' };
    }
    return { stdout: '' };
  });

  const directory = mkdtempSync(join(tmpdir(), 'saga-image-obs-'));
  try {
    const executor = new DockerReadinessExecutor(directory, IMAGE);
    executor.prepare(null, 60_000);
    const description = executor.describe();

    // GREEN oracle 1 — ONE reference-resolution call, and it is the
    // one-snapshot shape (BOTH fields asked in ONE --format). The pre-fix
    // two-inspect implementation records 2 calls here and is red.
    assert.equal(identityInspects.length, 1,
      'exactly ONE reference-resolution inspect on the mutable declared tag — never two');
    assert.match(identityInspects[0].format, /\.RepoDigests/u,
      'the single resolution asks for RepoDigests');
    assert.match(identityInspects[0].format, /\.Id/u,
      'the SAME single resolution asks for the local Id');

    // GREEN oracle 2 — PAIRED facts: both derive from resolution #1
    // (image A). The pre-fix split (A's digest from call #1, B's id from
    // call #2) makes resolvedImageId ID_B here and is red.
    assert.equal(description.substrate, 'docker');
    assert.equal(description.baseImageDigest, MANIFEST_A,
      'the receipt identity is the manifest digest of the ONE observed snapshot');
    assert.equal(description.resolvedImageId, ID_A,
      'the provenance id is the SAME snapshot\'s id — a tag switch between two inspects can no longer pair A\'s digest with B\'s id');

    // GREEN oracle 3 — the base tag froze ONLY the immutable Id of that
    // same snapshot. The pre-fix split tags B's id here and is red.
    assert.equal(tagCalls.length, 1, 'exactly one base-tag freeze');
    assert.equal(tagCalls[0][0], 'tag');
    assert.equal(tagCalls[0][1], ID_A,
      'the session base tag references the immutable Id of the SAME snapshot — never the mutable declared tag, never a second resolution');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    installDockerImageCliForTests(null);
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('K19 atomic observation: a daemon fault DURING the identity snapshot stays a PLAIN error — identity is K19-owned, the ADR-091 classifier owns availability', () => {
  const {
    DockerReadinessExecutor,
    installDockerImageCliForTests,
    installDockerInfoProbeForTests,
    resetDockerAvailabilityCache,
  } = dockerExecutorModule;
  assert.equal(typeof installDockerImageCliForTests, 'function');
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  installDockerImageCliForTests(args => {
    if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format'
        && String(args[3]).includes('.RepoDigests')) {
      return { status: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' };
    }
    return { stdout: '' };
  });
  const directory = mkdtempSync(join(tmpdir(), 'saga-image-obs-'));
  try {
    const executor = new DockerReadinessExecutor(directory, IMAGE);
    assert.throws(
      () => executor.prepare(null, 60_000),
      error => !(error instanceof ReadinessExecutionError),
      'a snapshot CLI fault throws a PLAIN error (the provider\'s ADR-091 classifier routes it by OBSERVATION), never a typed identity verdict',
    );
    assert.equal(executor.describe().baseImageDigest, undefined,
      'no identity is recorded from a failed observation');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    installDockerImageCliForTests(null);
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});
