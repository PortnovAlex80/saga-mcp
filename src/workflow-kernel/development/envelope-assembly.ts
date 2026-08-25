/**
 * workflow-kernel/development/envelope-assembly.ts - context envelope
 * assembly for the Development vertical + the production-size prompt
 * fixtures of the preserved Elite-3/Elite-8 failure classes (WP-08, plan
 * phase EK-5).
 *
 * Laws implemented here:
 *   - Every envelope is assembled from the SAME resolved
 *     CanonicalRoleContract (the protocol/semantic skill layers carry the
 *     pinned digests; no consumer reclassifies);
 *   - grammar-enforced layers (task-projection CS-06, workspace-summary
 *     CS-07) always declare the bounded transport form;
 *   - required scope / unknown / terminal-claim information travels either
 *     inline (bounded) or as a content-addressed external reference on the
 *     task-projection / large-product-refs layers - NEVER silently dropped
 *     to fit a budget. `requiredInfoDisposition` proves it per receipt.
 *
 * Production-size fixture classes (plan EK-5):
 *   - Elite-3: a ~436KB planner-class request (large static frame) that must
 *     be admitted whole at a production-scale profile, or refused typed at a
 *     smaller one - with the required info carried by reference in the
 *     admitted variant;
 *   - Elite-8: repeated recovery, large accepted products, duplicate
 *     metadata, Unicode, hooks/additional context, bounded tool results.
 *
 * PURITY: no I/O. Deterministic text builders only.
 */

import type { CanonicalRoleContract } from '../domain/types.js';
import type {
  ContextEnvelope,
  EnvelopeLayer,
  ExternalReference,
} from '../context-envelope/receipt.js';
import { countTokens } from '../context-envelope/accountant.js';

/* ------------------------------------------------------------------ */
/* Deterministic text builders (exact token counts)                    */
/* ------------------------------------------------------------------ */

/**
 * Text that counts to EXACTLY `tokens` tokens under the pinned counter
 * (ceil(len/4) per word): 4-char words separated by single spaces.
 */
export function tokenText(tokens: number, word = 'tok'): string {
  if (tokens <= 0) return '';
  return Array.from({ length: tokens }, () => word).join(' ');
}

/** Deterministic ASCII text of an exact UTF-8 byte length (word-patterned). */
export function byteText(bytes: number, word = 'data'): string {
  const unit = `${word} `; // len+1 bytes per word
  const words = Math.max(1, Math.floor(bytes / unit.length));
  let text = Array.from({ length: words }, () => word).join(' ');
  const shortfall = bytes - Buffer.byteLength(text, 'utf8');
  if (shortfall > 0) text += ' ' + 'x'.repeat(Math.min(shortfall - 1, 3));
  while (Buffer.byteLength(text, 'utf8') < bytes) text += 'x';
  return text.slice(0, bytes);
}

/** Deterministic multi-byte (Unicode) text of an exact UTF-8 byte length. */
export function unicodeText(bytes: number): string {
  // 3-byte words (Cyrillic + CJK mix), exact byte length via truncation-safe assembly.
  const words: string[] = [];
  let written = 0;
  let index = 0;
  const alphabet = ['данные', '数据', '※ reliably', 'πυθία', '🎉 факт', '検証'];
  while (written < bytes) {
    const word = alphabet[index % alphabet.length];
    const wordBytes = Buffer.byteLength(word, 'utf8') + 1;
    if (written + wordBytes > bytes) break;
    words.push(word);
    written += wordBytes;
    index += 1;
  }
  let text = words.join(' ');
  const remaining = bytes - Buffer.byteLength(text, 'utf8');
  if (remaining > 0) text += ' '.padEnd(remaining, '\u00a0'); // 1-byte padding to exact length
  return text;
}

/** sha256-free deterministic content-address builder for tests/fixtures. */
export function referenceOf(kind: string, digestHex: string, summary: string): ExternalReference {
  return { ref: `content://${kind}/${digestHex}`, digest: `sha256:${digestHex}`, summary };
}

/* ------------------------------------------------------------------ */
/* Development envelope assembly                                       */
/* ------------------------------------------------------------------ */

/** The bounded task-projection manifest: required info that must survive. */
export interface RequiredTaskInfo {
  /** Scope entries (capsule requirement refs). */
  readonly scope: readonly ExternalReference[];
  /** Discovery unknowns (may not disappear at a workshop boundary - D10). */
  readonly unknowns: readonly ExternalReference[];
  /** Terminal lifecycle claims (capsule). */
  readonly terminalClaims: readonly ExternalReference[];
}

export interface DevelopmentEnvelopeInputs {
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredTaskInfo;
  readonly workspaceSummary?: string;
  /** Elite-8 class: repeated recovery memory entries. */
  readonly recoveryHistory?: readonly string[];
  /** Elite-8 class: hooks / additionalContext blocks. */
  readonly hookContext?: readonly string[];
  /** Elite-8 class: retained (bounded) tool results. */
  readonly toolResults?: readonly string[];
  /** Elite-8 class: large accepted products travel by reference. */
  readonly largeProductRefs?: readonly ExternalReference[];
  readonly deskReference?: ExternalReference;
}

/** The mandatory tool-schema set of the Development cell (bounded, closed). */
const DEVELOPMENT_TOOL_SCHEMAS = [
  'tool:read-file (path) -> bytes',
  'tool:write-file (path, bytes) -> receipt',
  'tool:run-command (cmd) -> exit+stdout (bounded)',
];

/**
 * Assemble the Development context envelope. The skill layers carry the
 * pinned digests of the SAME resolved contract; the task projection embeds
 * the bounded summaries of every required scope/unknown/terminal-claim entry
 * and the exact references.
 */
export function assembleDevelopmentEnvelope(inputs: DevelopmentEnvelopeInputs): ContextEnvelope {
  const contract = inputs.roleContract;
  const layers: EnvelopeLayer[] = [
    {
      layer: 'initial-prompt-frame',
      content: `Development production task. ${inputs.taskSummary}`,
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
      content: DEVELOPMENT_TOOL_SCHEMAS.join('\n'),
    },
    {
      layer: 'write-authority',
      content: `write authority: cell workspace only; allowed=${contract.allowedToolRefs.join(',')}`,
    },
    {
      layer: 'task-projection',
      boundedTransportForm: true,
      content: taskProjectionContent(inputs.requiredInfo, inputs.taskSummary),
      externalReferences: [
        ...inputs.requiredInfo.scope,
        ...inputs.requiredInfo.unknowns,
        ...inputs.requiredInfo.terminalClaims,
      ],
    },
  ];
  if (inputs.workspaceSummary !== undefined || inputs.largeProductRefs !== undefined) {
    layers.push({
      layer: 'workspace-summary',
      boundedTransportForm: true,
      content: inputs.workspaceSummary ?? 'workspace: cell baseline only',
      ...(inputs.largeProductRefs !== undefined ? { externalReferences: inputs.largeProductRefs } : {}),
    });
  }
  if (inputs.recoveryHistory !== undefined && inputs.recoveryHistory.length > 0) {
    layers.push({ layer: 'recovery-history', content: inputs.recoveryHistory.join('\n') });
  }
  if (inputs.hookContext !== undefined && inputs.hookContext.length > 0) {
    layers.push({ layer: 'hook-context', content: inputs.hookContext.join('\n') });
  }
  if (inputs.toolResults !== undefined && inputs.toolResults.length > 0) {
    layers.push({ layer: 'tool-results', content: inputs.toolResults.join('\n') });
  }
  if (inputs.largeProductRefs !== undefined && inputs.largeProductRefs.length > 0) {
    layers.push({ layer: 'large-product-refs', content: `${inputs.largeProductRefs.length} accepted products travel by content address`, externalReferences: inputs.largeProductRefs });
  }
  if (inputs.deskReference !== undefined) {
    layers.push({ layer: 'desk-reference', content: inputs.deskReference.summary, externalReferences: [inputs.deskReference] });
  }
  return { layers };
}

/** Bounded task-projection content: every required info entry named + summarized (grammar CS-14). */
function taskProjectionContent(requiredInfo: RequiredTaskInfo, summary: string): string {
  const lines: string[] = [`task: ${summary}`];
  const entry = (label: string, refs: readonly ExternalReference[]): string[] =>
    refs.map((ref, index) => `${label}[${index}] ${ref.ref} :: ${ref.summary}`);
  lines.push(...entry('scope', requiredInfo.scope));
  lines.push(...entry('unknown', requiredInfo.unknowns));
  lines.push(...entry('terminal-claim', requiredInfo.terminalClaims));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Required-info disposition law (never silently dropped)              */
/* ------------------------------------------------------------------ */

/** One required info entry's disposition in an ADMITTED receipt. */
export type RequiredInfoDisposition =
  | { readonly id: string; readonly disposition: 'referenced-or-inline' }
  | { readonly id: string; readonly disposition: 'DROPPED' };

/**
 * Prove every required scope/unknown/terminal-claim entry of the manifest is
 * carried by the admitted receipt (as a content-addressed external
 * reference). Any DROPPED entry is a spec violation: the budget law omits
 * only optional layers, never required information.
 */
export function requiredInfoDisposition(
  manifest: RequiredTaskInfo,
  receiptExternalReferences: readonly ExternalReference[],
): RequiredInfoDisposition[] {
  const referenced = new Set(receiptExternalReferences.map((ref) => ref.ref));
  const all = [...manifest.scope, ...manifest.unknowns, ...manifest.terminalClaims];
  return all.map((entry) =>
    referenced.has(entry.ref)
      ? { id: entry.ref, disposition: 'referenced-or-inline' }
      : { id: entry.ref, disposition: 'DROPPED' },
  );
}

/** Assert helper: every entry of a manifest survived admission. */
export function allRequiredInfoSurvived(
  manifest: RequiredTaskInfo,
  receiptExternalReferences: readonly ExternalReference[],
): boolean {
  const referenced = new Set(receiptExternalReferences.map((ref) => ref.ref));
  const all = [...manifest.scope, ...manifest.unknowns, ...manifest.terminalClaims];
  return all.every((ref) => referenced.has(ref.ref));
}

/* ------------------------------------------------------------------ */
/* Production-size fixtures (Elite-3 / Elite-8)                        */
/* ------------------------------------------------------------------ */

/** The Elite-3 planner-class request size (the preserved 436KB class). */
export const ELITE3_REQUEST_BYTES = 436_000;

export interface Elite3Fixture {
  readonly envelope: ContextEnvelope;
  readonly requiredInfo: RequiredTaskInfo;
  readonly frameBytes: number;
  readonly frameTokens: number;
}

/**
 * Elite-3: a ~436KB planner request. The static frame is the large part;
 * required scope/unknown/terminal-claim info travels as content-addressed
 * references on the task projection AND is summarized inline (bounded).
 */
export function elite3PlannerFixture(sizeBytes: number = ELITE3_REQUEST_BYTES): Elite3Fixture {
  const requiredInfo: RequiredTaskInfo = {
    scope: [0, 1, 2].map((index) => referenceOf('requirements', `e3req${index}${'0'.repeat(58 - index - 5)}`, `requirement ${index}: deterministic message service`)),
    unknowns: [referenceOf('unknowns', 'e3unk0000000000000000000000000000000000000000000000000000058', 'browser matrix unknown (owner: discovery)')],
    terminalClaims: [0, 1].map((index) => referenceOf('terminal-claims', `e3tc${index}${'0'.repeat(58 - index - 4)}`, `terminal claim ${index}: loopback + smoke green`)),
  };
  const frame = byteText(sizeBytes, 'planner');
  return {
    envelope: {
      layers: [
        { layer: 'initial-prompt-frame', content: frame },
        { layer: 'protocol-skill', content: 'content://skills/protocol-planner digest=sha256:' + 'e3'.repeat(32) },
        { layer: 'semantic-skill', content: 'content://skills/semantic-planner digest=sha256:' + 'e3'.repeat(32) },
        { layer: 'tool-schemas', content: DEVELOPMENT_TOOL_SCHEMAS.join('\n') },
        { layer: 'write-authority', content: 'write authority: planning artifacts only' },
        {
          layer: 'task-projection',
          boundedTransportForm: true,
          content: taskProjectionContent(requiredInfo, 'Elite-3 production-size planner request'),
          externalReferences: [...requiredInfo.scope, ...requiredInfo.unknowns, ...requiredInfo.terminalClaims],
        },
      ],
    },
    requiredInfo,
    frameBytes: Buffer.byteLength(frame, 'utf8'),
    frameTokens: countTokens(frame),
  };
}

/** One Elite-8 class fixture envelope (each class exercises one boundary). */
export interface Elite8Fixtures {
  /** Repeated recovery memory (bounded by maxRecoveryTokens). */
  repeatedRecovery(recoveryEntries: number): ContextEnvelope;
  /** Large accepted products traveling by reference. */
  largeAcceptedProducts(count: number, bytesEach: number): { envelope: ContextEnvelope; productRefs: ExternalReference[]; totalProductBytes: number };
  /** Duplicate metadata: the same layer content twice under one layer name. */
  duplicateMetadata(base: ContextEnvelope): ContextEnvelope;
  /** Unicode-heavy dynamic content. */
  unicode(bytes: number): ContextEnvelope;
  /** Hooks / additionalContext blocks. */
  hooksAdditionalContext(blocks: number, tokensPerBlock: number): ContextEnvelope;
  /** Bounded tool results exceeding/within the tool-result budget. */
  boundedToolResults(tokens: number): ContextEnvelope;
  /** The shared contract-shaped skeleton for Elite-8 variants. */
  skeleton(roleContract: CanonicalRoleContract): ContextEnvelope;
}

export function elite8Fixtures(contract: CanonicalRoleContract): Elite8Fixtures {
  const skeleton: ContextEnvelope = {
    layers: [
      { layer: 'initial-prompt-frame', content: 'Elite-8 failure-class fixture frame.' },
      { layer: 'protocol-skill', content: `${contract.protocolSkillRef} digest=${contract.protocolSkillDigest}` },
      { layer: 'semantic-skill', content: `${contract.semanticSkillRef} digest=${contract.semanticSkillDigest}` },
      { layer: 'tool-schemas', content: DEVELOPMENT_TOOL_SCHEMAS.join('\n') },
      { layer: 'write-authority', content: 'write authority: cell workspace only' },
      { layer: 'task-projection', boundedTransportForm: true, content: 'task: Elite-8 boundary fixture' },
    ],
  };
  return {
    skeleton: () => skeleton,
    repeatedRecovery: (entries: number): ContextEnvelope => ({
      layers: [
        ...skeleton.layers,
        { layer: 'recovery-history', content: Array.from({ length: entries }, (_unused, index) => `recovery[${index}] prior gate feedback: repair requested (bounded memory entry ${index})`).join('\n') },
      ],
    }),
    largeAcceptedProducts: (count: number, bytesEach: number) => {
      const productRefs = Array.from({ length: count }, (_unused, index) =>
        referenceOf('accepted-products', `p${index}${'0'.repeat(57)}`, `accepted product ${index} (${bytesEach} bytes)`),
      );
      const totalProductBytes = count * bytesEach;
      return {
        envelope: {
          layers: [
            ...skeleton.layers,
            { layer: 'workspace-summary', boundedTransportForm: true, content: `workspace holds ${count} accepted products (${totalProductBytes} bytes) by reference` },
            { layer: 'large-product-refs', content: `${count} accepted products travel by content address`, externalReferences: productRefs },
          ],
        },
        productRefs,
        totalProductBytes,
      };
    },
    duplicateMetadata: (base: ContextEnvelope): ContextEnvelope => ({
      layers: [...base.layers, { ...base.layers[base.layers.length - 1], content: `${base.layers[base.layers.length - 1].content} (duplicated metadata copy)` }],
    }),
    unicode: (bytes: number): ContextEnvelope => ({
      layers: [...skeleton.layers, { layer: 'hook-context', content: unicodeText(bytes) }],
    }),
    hooksAdditionalContext: (blocks: number, tokensPerBlock: number): ContextEnvelope => ({
      layers: [
        ...skeleton.layers,
        { layer: 'hook-context', content: Array.from({ length: blocks }, (_unused, index) => `hook[SessionStart] additionalContext#${index}: ${tokenText(tokensPerBlock, 'hook')}`).join('\n') },
      ],
    }),
    boundedToolResults: (tokens: number): ContextEnvelope => ({
      layers: [...skeleton.layers, { layer: 'tool-results', content: tokenText(tokens, 'result') }],
    }),
  };
}
