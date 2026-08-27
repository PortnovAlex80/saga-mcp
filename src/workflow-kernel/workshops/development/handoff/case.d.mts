/**
 * handoff/case.d.mts - the TypeScript declaration of the FRF-WP09
 * DevelopmentCase desk (the .mjs beside this file is the runtime module,
 * mirrored into dist by the FRF-WP11 build step).
 */

export declare const DEVELOPMENT_CASE_KIND: string;
export declare const DEVELOPMENT_CASE_ENTRY_ID: string;

export declare function buildDevelopmentCase(inputs: {
  frozenBaseline: unknown;
  baselineArtifact: unknown;
  srs: unknown;
  repositoryPolicyRefs: readonly string[];
  solutionContract: unknown;
  architectureContract: unknown;
}):
  | { readonly ok: true; readonly developmentCase: Record<string, unknown>; readonly artifact: { readonly ref: string; readonly digest: string; readonly content: unknown } }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly detail: string };

export declare function validateDevelopmentCase(candidate: unknown, authorities: unknown):
  | { readonly ok: true; readonly artifact: { readonly ref: string; readonly digest: string; readonly content: unknown } }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly detail: string };
