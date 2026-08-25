/**
 * workflow-kernel/testing/fixtures.ts - deterministic production-size
 * payload fixtures for EK-9 budget/review/scale/rollover tests (WP-13B).
 *
 * Every fixture is GENERATED from a compact descriptor with a retained
 * seed: the committed bytes are the descriptor-generating code, never the
 * payload itself; two runs on any machine produce byte-identical artifacts
 * (the retained-seed law of the scenario contract).
 *
 * The observed production classes are preserved as generator classes, each
 * named after the real incident class it reproduces:
 *
 *   - planner-request: the Elite-3 retry-snowball planner prompt
 *     (docs/factory-run/stage20-elite/RUN-TRACKER.md:214 - the request hit
 *     436,283 bytes of UNBOUNDEDLY accumulated gate-rejection feedback, the
 *     provider rejected it pre-tool 8 times, the run terminalized failed);
 *   - recovery-history: the repeated recovery epoch feedback layer;
 *   - accepted-product: a large accepted product body;
 *   - duplicate-metadata: byte-identical metadata rows repeated;
 *   - unicode-content: multi-script content (Cyrillic/CJK/diacritics/emoji);
 *   - hook-context: hook additionalContext payloads;
 *   - tool-result: bounded retained tool results.
 *
 * Scales: minimum, normal production, observed maximum (the Elite-3 byte
 * figure). Token counts use the pinned WP-18 counter so fixture token
 * claims are exact under the accountant's own rule.
 *
 * PURITY: node:crypto + the domain PRNG only. No clock, no network.
 */

import { createHash } from 'node:crypto';
import { mulberry32 } from '../domain/explorer.js';
import { countTokens } from '../context-envelope/accountant.js';

/* ------------------------------------------------------------------ */
/* The observed production constants (pinned, not invented)             */
/* ------------------------------------------------------------------ */

/**
 * Real observed production figures (stage20-elite RUN-TRACKER and the
 * Elite-3 post-mortem). The maximum payload scale reproduces the exact
 * observed byte figure; committed code stays a few KB regardless.
 */
export const OBSERVED_PRODUCTION = {
  /** The Elite-3 planner request the provider rejected pre-tool (bytes). */
  elite3PlannerRequestBytes: 436283,
  /** Gate rejections burned by the planner epochs 1-3 before the snowball. */
  elite3PlannerGateRejections: 9,
  /** Pre-tool shim deaths on the oversized request. */
  elite3ShimRetries: 8,
  /** Executions lost to the snowball before the budget terminalized the run. */
  elite3LostExecutions: 3,
  /** The EARLIER accepted planner submission in the same run (16+16 items). */
  elite3AcceptedImplItems: 16,
  elite3AcceptedVerificationItems: 16,
} as const;

/** Fixture generator classes (the preserved observed classes). */
export const FIXTURE_CLASSES = [
  'planner-request',
  'recovery-history',
  'accepted-product',
  'duplicate-metadata',
  'unicode-content',
  'hook-context',
  'tool-result',
] as const;
export type FixtureClass = (typeof FIXTURE_CLASSES)[number];

/** Payload scale dimension: minimum / normal production / observed maximum. */
export const FIXTURE_SCALES = ['minimum', 'normal', 'observed-maximum'] as const;
export type FixtureScale = (typeof FIXTURE_SCALES)[number];

/** Compact fixture descriptor: the committed form of a fixture. */
export interface FixtureDescriptor {
  readonly kind: FixtureClass;
  readonly scale: FixtureScale;
  readonly seed: number;
}

/** One generated fixture artifact (deterministic from its descriptor). */
export interface GeneratedFixture {
  readonly descriptor: FixtureDescriptor;
  readonly text: string;
  readonly byteLength: number;
  readonly tokenCount: number;
  readonly sha256: string;
}

/* ------------------------------------------------------------------ */
/* Target sizes per class and scale                                    */
/* ------------------------------------------------------------------ */

/** The exact target byte size of one descriptor (deterministic). */
export function fixtureTargetBytes(descriptor: FixtureDescriptor): number {
  const observedMaximum = descriptor.scale === 'observed-maximum';
  switch (descriptor.kind) {
    case 'planner-request':
      // The Elite-3 figure at maximum; a minimal well-formed request at
      // minimum; a normal planner request otherwise.
      return observedMaximum ? OBSERVED_PRODUCTION.elite3PlannerRequestBytes : descriptor.scale === 'minimum' ? 512 : 24_576;
    case 'recovery-history':
      return observedMaximum ? 196_608 : descriptor.scale === 'minimum' ? 256 : 16_384;
    case 'accepted-product':
      return observedMaximum ? 262_144 : descriptor.scale === 'minimum' ? 384 : 32_768;
    case 'duplicate-metadata':
      return observedMaximum ? 65_536 : descriptor.scale === 'minimum' ? 128 : 8_192;
    case 'unicode-content':
      return observedMaximum ? 65_536 : descriptor.scale === 'minimum' ? 192 : 4_096;
    case 'hook-context':
      return observedMaximum ? 131_072 : descriptor.scale === 'minimum' ? 96 : 2_048;
    case 'tool-result':
      return observedMaximum ? 98_304 : descriptor.scale === 'minimum' ? 64 : 1_024;
    default:
      return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic byte-exact text generation                            */
/* ------------------------------------------------------------------ */

/** Closed word vocabularies per class (repeated deterministically). */
const CLASS_VOCABULARY: Readonly<Record<FixtureClass, readonly string[]>> = {
  'planner-request': [
    'epoch', 'rejected:', 'pairwise', 'overlap', 'implementation', 'items', 'dependency', 'order', 'closure', 'acyclicity',
    'feedback', 'retry', 'prompt', 'accumulated', 'planner', 'gate', 'verdict', 'submission', 'digest', 'verification',
  ],
  'recovery-history': ['recovery', 'epoch', 'prior', 'attempt', 'failed', 'resume', 'stateless', 'redrive', 'obligation', 'retry'],
  'accepted-product': ['accepted', 'material', 'revision', 'workplace', 'contribution', 'sealed', 'candidate', 'authority', 'cell', 'proof'],
  'duplicate-metadata': ['meta', 'row', 'identical', 'repeat', 'duplicate', 'same', 'bytes', 'equal', 'copy', 'again'],
  'unicode-content': [],
  'hook-context': ['hook', 'additionalContext', 'session', 'inject', 'oversized', 'pre-send', 'receipt', 'next', 'exact', 'bytes'],
  'tool-result': ['tool', 'result', 'bounded', 'retained', 'schema', 'output', 'truncated', 'cap', 'tokens', 'layer'],
};

/** Multi-script word list for the unicode class (2-4 UTF-8 bytes each). */
const UNICODE_WORDS = [
  'данные', '模型', 'señal', 'Ωμέγα', '検証', 'координата', '规范', 'mmærke', 'тест', '規範',
  'αποτέλεσμα', 'измерение', '辞書', 'übergeben', 'проверка', '実装', 'Ελλάδα', 'сигнал', '變體', '✓done',
] as const;

/** A deterministic word of the planner rejection-feedback grammar. */
function rejectionFeedbackLine(rng: () => number, epoch: number): string {
  const vocab = CLASS_VOCABULARY['planner-request'];
  const pick = (): string => vocab[Math.floor(rng() * vocab.length)];
  return `epoch ${epoch} rejected: implementation items ${pick()} and ${pick()} overlap without a dependency order; closure ${pick()}; feedback retained unboundedly`;
}

/** A string of exactly `bytes` UTF-8 bytes ('a' = 1, 'é' = 2, '€' = 3). */
function utf8TailExact(bytes: number): string {
  if (bytes <= 0) return '';
  const twoByteChars = Math.floor(bytes / 2);
  const remainder = bytes - twoByteChars * 2;
  return 'é'.repeat(twoByteChars) + (remainder === 1 ? 'a' : '');
}

/**
 * Generate the fixture of one descriptor. Deterministic: mulberry32(seed)
 * over the closed class vocabulary, padded byte-exact with a UTF-8 tail.
 */
export function generateFixture(descriptor: FixtureDescriptor): GeneratedFixture {
  const target = fixtureTargetBytes(descriptor);
  const rng = mulberry32(descriptor.seed >>> 0);
  const chunks: string[] = [];
  let bytes = 0;

  if (descriptor.kind === 'unicode-content') {
    // Multi-script words, byte-accounted exactly, joined with ASCII spaces.
    while (bytes < target) {
      const word = UNICODE_WORDS[Math.floor(rng() * UNICODE_WORDS.length)];
      const wordBytes = Buffer.byteLength(word, 'utf8');
      const separator = bytes === 0 ? 0 : 1;
      if (bytes + separator + wordBytes > target) break;
      chunks.push(bytes === 0 ? word : ` ${word}`);
      bytes += separator + wordBytes;
    }
  } else if (descriptor.kind === 'planner-request') {
    // The Elite-3 shape: a header line then unboundedly repeated rejection
    // feedback blocks (the retry-snowball root cause F-A).
    const header = `planner retry prompt; epochs 1..${OBSERVED_PRODUCTION.elite3PlannerGateRejections}; earlier accepted submission ${OBSERVED_PRODUCTION.elite3AcceptedImplItems}+${OBSERVED_PRODUCTION.elite3AcceptedVerificationItems} items\n`;
    chunks.push(header);
    bytes += Buffer.byteLength(header, 'utf8');
    let epoch = 1;
    while (true) {
      const line = `${rejectionFeedbackLine(rng, epoch)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (bytes + lineBytes > target) break;
      chunks.push(line);
      bytes += lineBytes;
      epoch = (epoch % OBSERVED_PRODUCTION.elite3PlannerGateRejections) + 1;
    }
  } else {
    const vocab = CLASS_VOCABULARY[descriptor.kind];
    while (true) {
      const word = vocab[Math.floor(rng() * vocab.length)];
      const separator = bytes === 0 ? 0 : 1;
      if (bytes + separator + word.length > target) break;
      chunks.push(bytes === 0 ? word : ` ${word}`);
      bytes += separator + word.length;
    }
  }

  // Byte-exact deterministic tail (2/3-byte characters, counted in bytes).
  const remaining = target - bytes;
  if (remaining > 0) {
    const tail = utf8TailExact(remaining);
    chunks.push(tail);
    bytes += Buffer.byteLength(tail, 'utf8');
  }

  const text = chunks.join('');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength !== target) {
    throw new Error(`fixture ${descriptor.kind}/${descriptor.scale}: generated ${byteLength} bytes, target ${target} (generator defect)`);
  }
  return {
    descriptor,
    text,
    byteLength,
    tokenCount: countTokens(text),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

/** The full deterministic fixture corpus (7 classes x 3 scales). */
export function fixtureCorpus(seed = 20260826): GeneratedFixture[] {
  const corpus: GeneratedFixture[] = [];
  for (const kind of FIXTURE_CLASSES) {
    for (const scale of FIXTURE_SCALES) {
      corpus.push(generateFixture({ kind, scale, seed }));
    }
  }
  return corpus;
}

/* ------------------------------------------------------------------ */
/* Envelope layer helpers (fixtures -> WP-18 context envelopes)         */
/* ------------------------------------------------------------------ */

/** n 4-char words: exactly n tokens under the pinned counter. */
export function tokenText(tokens: number): string {
  if (tokens <= 0) return '';
  return Array.from({ length: tokens }, () => 'aaaa').join(' ');
}

/** The five mandatory-inline envelope layers with exact token counts. */
export function mandatoryLayers(eachTokens = 3): { layer: 'initial-prompt-frame' | 'protocol-skill' | 'semantic-skill' | 'tool-schemas' | 'write-authority'; content: string }[] {
  return [
    { layer: 'initial-prompt-frame', content: tokenText(eachTokens) },
    { layer: 'protocol-skill', content: tokenText(eachTokens) },
    { layer: 'semantic-skill', content: tokenText(eachTokens) },
    { layer: 'tool-schemas', content: tokenText(eachTokens) },
    { layer: 'write-authority', content: tokenText(eachTokens) },
  ];
}
