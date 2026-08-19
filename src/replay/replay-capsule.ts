import { sha256Hex } from '../shared/canonical-json.js';

export const REPLAY_CAPSULE_SCHEMA = 'factory.replay-capsule.v1' as const;
export const REPLAY_POLICY_REF = 'factory.replay-first.v1' as const;
export const REPLAY_POLICY_DIGEST = sha256Hex({
  policy: REPLAY_POLICY_REF,
  semantics: 'exact-certified-capsule-before-model;fresh-gates-always',
});

export interface ReplayKeyMaterial {
  readonly projectId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly productionCellId: string;
  readonly workKey: string;
  readonly role: 'author' | 'reviewer';
  readonly packageDigest: string;
  /**
   * Cross-run-stable semantic input digest (CONVEYOR v4.3 §8-9). Authored by
   * the Production Cell from known semantic material (canonical business input
   * for entry cells; upstream semanticDigest + stable item for fan-out). NOT
   * the raw nodeInputHash, which carries run-specific provenance.
   */
  readonly semanticInputDigest: string;
  /**
   * Reviewer capsules are pinned to the semantic author production digest
   * (CONVEYOR v4.3 §10): a canonical { schemaId, digest } multiset of the
   * subject author CandidateSet's products. Stable across runs even though
   * the CandidateSet's own digest binds WorkplaceRef + production revision.
   */
  readonly subjectProductionDigest: string | null;
}

export function computeReplayKey(input: ReplayKeyMaterial): string {
  return sha256Hex({ schema: REPLAY_CAPSULE_SCHEMA, ...input });
}

export interface ReplayInputBinding {
  readonly path: string;
  readonly value: string | number | boolean | null;
}

export interface ReplayTypedProduct {
  readonly schema: string;
  readonly content: unknown;
  readonly contentHash: string;
}

export interface ReplayArtifactSelector {
  readonly type: string;
  readonly code: string | null;
  readonly title: string;
  readonly path: string;
  readonly contentHash: string | null;
}

export interface ReplayArtifactProduct {
  readonly selector: ReplayArtifactSelector;
  readonly projectRepositoryId: number | null;
  readonly status: 'draft' | 'in_review';
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly parent: ReplayArtifactSelector | null;
  readonly file: {
    readonly encoding: 'base64';
    readonly bytes: string;
  } | null;
}

export interface ReplayTraceProduct {
  readonly source: ReplayArtifactSelector;
  readonly targetType: 'artifact' | 'task';
  readonly targetArtifact: ReplayArtifactSelector | null;
  /** Stable task generation key when a trace targets a task. */
  readonly targetTaskGenerationKey: string | null;
  readonly linkType: string;
}

export interface ReplayGitRecipe {
  readonly projectRepositoryId: number;
  readonly integrationBranch: string;
  readonly baseCommit: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly sourceBranch: string;
  readonly patchBase64: string;
  readonly commit: {
    readonly authorName: string;
    readonly authorEmail: string;
    readonly authorDate: string;
    readonly committerName: string;
    readonly committerEmail: string;
    readonly committerDate: string;
    readonly message: string;
  };
}

/**
 * A capsule contains only worker production. It never stores GateDecision,
 * lifecycle state, task status or any other authority. Replaying a capsule
 * must publish these products through the normal MCP/product surface and let
 * the current CandidateSet + GateRun decide acceptance again.
 */
export interface ReplayCapsulePayload {
  readonly schemaVersion: typeof REPLAY_CAPSULE_SCHEMA;
  readonly key: ReplayKeyMaterial;
  readonly replayKey: string;
  readonly inputBindings: readonly ReplayInputBinding[];
  readonly typedProducts: readonly ReplayTypedProduct[];
  readonly artifacts: readonly ReplayArtifactProduct[];
  readonly traces: readonly ReplayTraceProduct[];
  readonly git: ReplayGitRecipe | null;
  /**
   * B-004/W-3 — typed marker present ONLY on capsules that certify
   * KERNEL-presented carried-forward material (the carry-forward presenter
   * has no worker execution; the sealed authorization is the provenance).
   */
  readonly presentedBy?: string;
}

export interface ReplayCapsuleRecord {
  readonly capsuleRef: string;
  readonly replayKey: string;
  readonly projectId: number;
  readonly sourceExecutionRef: string;
  readonly sourceCandidateSetRef: string;
  readonly payloadHash: string;
  readonly payload: ReplayCapsulePayload;
  readonly createdAt: string;
}

export interface ReplayClaimSelection {
  readonly replayKey: string;
  readonly capsuleRef: string | null;
  readonly capsulePayloadHash: string | null;
}
