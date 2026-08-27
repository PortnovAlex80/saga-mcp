/**
 * handoff/lifecycle.d.mts - the TypeScript declaration of the FRF-WP09
 * lifecycle mapping module (the .mjs beside this file is the runtime
 * module, mirrored into dist by the FRF-WP11 build step).
 */

export declare const FORMALIZATION_TO_DEVELOPMENT_EDGE: {
  readonly carries: readonly string[];
  readonly from: { readonly nodeId: string; readonly on: string; readonly terminalNodeId: string; readonly workshopId: string };
  readonly kind: string;
  readonly to: { readonly developmentEntryId: string; readonly workshopId: string };
};

export declare function mapSettlementToDevelopmentEntry(settled: unknown):
  | { readonly ok: true; readonly edge: typeof FORMALIZATION_TO_DEVELOPMENT_EDGE; readonly entry: string }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly detail: string };

export declare function lifecycleHandoffRecord(settled: unknown, devCase: unknown):
  | { readonly ok: true; readonly carried: readonly string[]; readonly edge: typeof FORMALIZATION_TO_DEVELOPMENT_EDGE; readonly handoffFingerprint: unknown; readonly solutionContractRef: string }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly detail: string };
