/**
 * workflow-kernel/workshops/formalization/envelope.ts - context envelope
 * assembly for the Formalization desks (WP-11F, plan phase EK-8 workshop
 * conversion).
 *
 * Laws (the WP-18 envelope grammar, applied to formalization content):
 *   - Every envelope is assembled from the SAME resolved
 *     CanonicalRoleContract (the protocol/semantic skill layers carry the
 *     pinned digests; no consumer reclassifies);
 *   - grammar-enforced layers (task-projection, workspace-summary) always
 *     declare the bounded transport form;
 *   - required information (Discovery source claims, constraints, unknowns,
 *     terminal lifecycle claims, upstream accepted material) travels inline
 *     (bounded) AND as content-addressed external references - NEVER
 *     silently dropped to fit a budget.
 *
 * PURITY: no I/O. Deterministic text builders only.
 */

import type { CanonicalRoleContract } from '../../domain/types.js';
import type {
  ContextEnvelope,
  EnvelopeLayer,
  ExternalReference,
} from '../../context-envelope/receipt.js';

/** The bounded task-projection manifest: required info that must survive. */
export interface FormalizationRequiredInfo {
  /** Discovery source claims (the derivation root of every desk). */
  readonly sourceClaims: readonly ExternalReference[];
  /** Source constraints the PRD must carry. */
  readonly constraints: readonly ExternalReference[];
  /** Discovery unknowns (may not disappear at a workshop boundary - D10). */
  readonly unknowns: readonly ExternalReference[];
  /** Terminal lifecycle claims (capsule). */
  readonly terminalClaims: readonly ExternalReference[];
  /** Upstream accepted material this desk derives from (revision refs). */
  readonly upstreamAccepted: readonly ExternalReference[];
}

export interface FormalizationEnvelopeInputs {
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: FormalizationRequiredInfo;
  /** Bounded recovery memory (repair-loop feedback). */
  readonly recoveryHistory?: readonly string[];
  /** Installed-hook additionalContext blocks (declared in the manifest). */
  readonly hookContext?: readonly string[];
  /** Retained (bounded) tool results. */
  readonly toolResults?: readonly string[];
  /** The current desk's contract reference. */
  readonly deskReference?: ExternalReference;
}

/** The mandatory tool-schema surface of a formalization desk (closed set from the installed manifest). */
const FORMALIZATION_TOOL_SCHEMAS = [
  'tool:artifact_create (kind, content) -> artifact ref',
  'tool:artifact_update (ref, content) -> new immutable revision',
  'tool:trace_add (artifact refs, relation) -> trace ref',
  'tool:product_submit (candidate, payload contract) -> intake receipt',
  'tool:read-file (path) -> bytes',
];

/**
 * Assemble the formalization context envelope. The skill layers carry the
 * pinned digests of the SAME resolved contract; the task projection embeds
 * the bounded summaries of every required entry plus the exact references.
 */
export function assembleFormalizationEnvelope(inputs: FormalizationEnvelopeInputs): ContextEnvelope {
  const contract = inputs.roleContract;
  const layers: EnvelopeLayer[] = [
    {
      layer: 'initial-prompt-frame',
      content: `Formalization desk task. ${inputs.taskSummary}`,
    },
    {
      layer: 'protocol-skill',
      content: `${contract.protocolSkillRef} digest=${contract.protocolSkillDigest}`,
    },
    {
      layer: 'semantic-skill',
      content: `${contract.semanticSkillRef} digest=${contract.semanticSkillDigest}`,
    },
    {
      layer: 'tool-schemas',
      content: FORMALIZATION_TOOL_SCHEMAS.join('\n'),
    },
    {
      layer: 'write-authority',
      content: `write authority: desk artifacts only; allowed=${contract.allowedToolRefs.join(',')}`,
    },
    {
      layer: 'task-projection',
      boundedTransportForm: true,
      content: taskProjectionContent(inputs.requiredInfo, inputs.taskSummary),
      externalReferences: [
        ...inputs.requiredInfo.sourceClaims,
        ...inputs.requiredInfo.constraints,
        ...inputs.requiredInfo.unknowns,
        ...inputs.requiredInfo.terminalClaims,
        ...inputs.requiredInfo.upstreamAccepted,
      ],
    },
    {
      layer: 'workspace-summary',
      boundedTransportForm: true,
      content: `workspace: ${inputs.requiredInfo.upstreamAccepted.length} accepted upstream revisions travel by content address`,
    },
  ];
  if (inputs.recoveryHistory !== undefined && inputs.recoveryHistory.length > 0) {
    layers.push({ layer: 'recovery-history', content: inputs.recoveryHistory.join('\n') });
  }
  if (inputs.hookContext !== undefined && inputs.hookContext.length > 0) {
    layers.push({ layer: 'hook-context', content: inputs.hookContext.join('\n') });
  }
  if (inputs.toolResults !== undefined && inputs.toolResults.length > 0) {
    layers.push({ layer: 'tool-results', content: inputs.toolResults.join('\n') });
  }
  if (inputs.deskReference !== undefined) {
    layers.push({ layer: 'desk-reference', content: inputs.deskReference.summary, externalReferences: [inputs.deskReference] });
  }
  return { layers };
}

/** Bounded task-projection content: every required entry named + summarized. */
function taskProjectionContent(requiredInfo: FormalizationRequiredInfo, summary: string): string {
  const lines: string[] = [`task: ${summary}`];
  const entry = (label: string, refs: readonly ExternalReference[]): string[] =>
    refs.map((ref, index) => `${label}[${index}] ${ref.ref} :: ${ref.summary}`);
  lines.push(...entry('source-claim', requiredInfo.sourceClaims));
  lines.push(...entry('constraint', requiredInfo.constraints));
  lines.push(...entry('unknown', requiredInfo.unknowns));
  lines.push(...entry('terminal-claim', requiredInfo.terminalClaims));
  lines.push(...entry('upstream-accepted', requiredInfo.upstreamAccepted));
  return lines.join('\n');
}

/** Required-info disposition law: prove every entry survived admission. */
export function allRequiredInfoSurvived(
  manifest: FormalizationRequiredInfo,
  receiptExternalReferences: readonly ExternalReference[],
): boolean {
  const referenced = new Set(receiptExternalReferences.map((ref) => ref.ref));
  const all = [
    ...manifest.sourceClaims,
    ...manifest.constraints,
    ...manifest.unknowns,
    ...manifest.terminalClaims,
    ...manifest.upstreamAccepted,
  ];
  return all.every((ref) => referenced.has(ref.ref));
}
