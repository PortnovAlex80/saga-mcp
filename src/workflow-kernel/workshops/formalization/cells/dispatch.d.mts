/**
 * cells/dispatch.d.mts - the TypeScript declaration of the installed
 * semantic dispatch (FRF-WP11 cutover; see dispatch.mjs beside this file
 * for the documented laws). The runtime module is pure .mjs (it binds the
 * .mjs cells and the in-package WP03 validators natively); this
 * declaration is the typed surface gates.ts and driver.ts compile
 * against.
 */

/** One gate issue (typed source + detail; mirrors gates.ts SemanticGateIssue). */
export declare interface DispatchIssue {
  readonly source: string;
  readonly detail: string;
}

/** The accepted Discovery-handoff seed of the chain. */
export declare interface HandoffSeed {
  readonly digest: string;
  readonly sourceClaimIds: readonly string[];
  readonly constraintIds?: readonly string[];
  readonly unknownIds?: readonly string[];
  readonly terminalClaimIds?: readonly string[];
}

/**
 * The accepted-material chain (the ADR-053 lineage authority; successor
 * of the deleted contribution.ts fold). Each desk's entry carries the
 * EXACT accepted sets the next desk validates against.
 */
export declare interface AcceptedChain {
  readonly handoff: {
    readonly digest: string;
    readonly sourceClaimIds: readonly string[];
    readonly constraintIds: readonly string[];
    readonly unknownIds: readonly string[];
    readonly terminalClaimIds: readonly string[];
  };
  readonly prd?: {
    readonly acceptedSet: {
      readonly revisionDigest: string;
      readonly prdMemberIds: readonly string[];
      readonly scenarioRequiredMemberIds: readonly string[];
      readonly memberDigests: readonly string[];
    };
    readonly bundle: unknown;
  };
  readonly useCases?: {
    readonly acceptedSet: {
      readonly revisionDigest: string;
      readonly scenarioIds: readonly string[];
      readonly branchIdsByScenario: Readonly<Record<string, readonly string[]>>;
      readonly coveredPrdMemberIds: readonly string[];
    };
    readonly bundle: unknown;
  };
  readonly requirements?: {
    readonly sealed: { readonly ref: string; readonly digest: string; readonly bundle: Record<string, unknown> };
    readonly universe: unknown;
  };
  readonly acceptance?: {
    readonly universe: unknown;
    readonly bundle: { readonly criteria: readonly unknown[]; readonly deferrals?: readonly unknown[]; readonly standaloneEvidenceBindings?: readonly unknown[] };
  };
  readonly reconciliation?: { readonly report: Record<string, unknown> };
  readonly baseline?: {
    readonly baseline: Record<string, unknown>;
    readonly artifact: { readonly ref: string; readonly digest: string; readonly content: unknown };
  };
  readonly srs?: {
    readonly architectureContract: Record<string, unknown>;
    readonly srsAuthority: { readonly revisionDigest: string; readonly realizationEntryIds: readonly string[]; readonly surfaces: readonly string[] };
  };
  readonly solution?: {
    readonly contract: Record<string, unknown>;
    readonly artifact: { readonly ref: string; readonly digest: string; readonly content: unknown };
    readonly repositoryPolicyRefs: readonly string[];
  };
}

/** One authored desk candidate (the exact material carried by the transition). */
export declare interface DeskCandidate {
  /** The desk's authored product kind (must equal the manifest row's kind). */
  readonly kind: string;
  /** The authored bundle / draft / handoff-values / report payload. */
  readonly product?: unknown;
  /** Authored desk inputs (verificationSurfaceIds, verifiableStatementIds, evidenceBindings, srsRevisionDigest, repositoryPolicyRefs). */
  readonly deskInput?: Record<string, unknown>;
  /** The freeze desk's exact accepted-authority surfaces. */
  readonly surfaces?: unknown;
}

/** The fold payload of one accepted desk (the chain-advancing material). */
export declare interface DeskFold {
  readonly kind: string;
  readonly acceptedSet?: unknown;
  readonly bundle?: unknown;
  readonly sealed?: unknown;
  readonly universe?: unknown;
  readonly report?: unknown;
  readonly baseline?: unknown;
  readonly artifact?: unknown;
  readonly architectureContract?: unknown;
  readonly srsAuthority?: unknown;
  readonly contract?: unknown;
  readonly repositoryPolicyRefs?: readonly string[];
}

/** The dispatch outcome (the routed verdict + the fold, or a typed refusal). */
export declare type DeskDispatch =
  | {
      readonly verdict: 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';
      readonly issues: readonly DispatchIssue[];
      readonly providerId: string;
      readonly productRef?: string;
      readonly fold?: DeskFold;
      readonly wait?: unknown;
      readonly outcome?: string;
    }
  | {
      readonly ok: false;
      readonly refused: true;
      readonly reason: string;
      readonly detail: string;
    };

export declare function acceptedChainOfHandoff(handoff: HandoffSeed): AcceptedChain;
export declare function foldDeskAcceptance(chain: AcceptedChain, nodeId: string, fold: DeskFold | undefined): AcceptedChain;
export declare function evaluateDeskCandidate(deskId: string, candidate: DeskCandidate, chain: AcceptedChain): DeskDispatch;
export declare function installedRequirementsSeamBinding(): unknown;
