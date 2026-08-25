/**
 * workflow-kernel/roles/fixtures/invalid-arbitrary-field.ts - the synthetic
 * INVALID contract for negative testing (WP-17).
 *
 * The implementer-profile content plus one arbitrary field (`metadata`) -
 * the extension bag the plan bans ("The role contract contains no free-form
 * metadata, extension bag, inline transition policy or executable policy
 * blob. Adding a field or reference kind reopens EK-1"). The compiler must
 * refuse it through the frozen schema's additionalProperties:false, and
 * must never return a value with the field silently dropped.
 */

import type { CompileRoleContractInput, RoleContractContent } from '../compiler.js';
import { buildImplementerFixture } from './implementer.js';

/** The arbitrary field that makes this contract invalid. */
export interface InvalidArbitraryFieldContent extends RoleContractContent {
  readonly metadata: { readonly note: string };
}

/**
 * The invalid compile attempt: a valid manifest row, valid artifacts and
 * poisoned content - the arbitrary field is the ONLY defect, so the RED it
 * causes is attributable to the extension-bag ban alone.
 */
export type InvalidArbitraryFieldInput = Omit<CompileRoleContractInput, 'content'> & {
  readonly content: InvalidArbitraryFieldContent;
};

/** The implementer fixture content with the forbidden extension field. */
export function buildInvalidArbitraryFieldFixture(): InvalidArbitraryFieldInput {
  const base = buildImplementerFixture();
  return {
    binding: base.binding,
    artifacts: base.artifacts,
    content: {
      ...base.content,
      metadata: { note: 'extension bag' },
    },
  };
}