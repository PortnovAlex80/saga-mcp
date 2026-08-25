/**
 * workflow-kernel/workshops/discovery/waits.ts - the typed-wait vocabulary
 * of the Discovery workshop (WP-11D).
 *
 * LAW (plan EK-8 + frozen universe): a workshop composes the FIVE frozen
 * wait kinds; it can never invent one. Discovery legitimately waits in
 * exactly two places, both discharged through public kernel commands:
 *
 *   TypedWait:human-input      (D5) - the decision fork: the intent product
 *                                     says needs-human; the operator
 *                                     resolves via workplace.resolveHumanResponse;
 *   TypedWait:effect-uncertainty (D12) - the registered-decision effect
 *                                     settled unknown; the operator
 *                                     disposition command is the ONLY wake
 *                                     source (never an automatic duplicate).
 *
 * This module refuses an invented wait kind with a typed UNIVERSE_VIOLATION
 * (the wait-kind-invention fence); the wake-source vocabulary is read from
 * the frozen universe registry - never restated here.
 *
 * PURITY: imports the frozen universe + domain types only.
 */

import type { TypedRefusal } from '../../domain/types.js';
import type { CommandName, WaitKind } from '../../domain/universe.js';
import { WAITS } from '../../domain/universe.js';

/** One declared wait kind of this workshop (data; the manifest pins the set). */
export interface DeclaredWaitKind {
  readonly kind: WaitKind;
  readonly reason: 'D5' | 'D12';
  readonly legitimateWait: string;
}

/** The wait vocabulary Discovery legitimately uses (D5/D12 only). */
export const DECLARED_WAIT_KINDS: readonly DeclaredWaitKind[] = [
  {
    kind: 'TypedWait:human-input',
    reason: 'D5',
    legitimateWait: 'the decision fork: the intent decision needs-human; the operator wake command discharges it',
  },
  {
    kind: 'TypedWait:effect-uncertainty',
    reason: 'D12',
    legitimateWait: 'the registered-decision effect settled unknown; the operator disposition is the only wake source',
  },
];

/** Every wait kind outside the frozen five (the invention fence input). */
export type InventedWaitKind = string & {};

export type DiscoveryWaitResolution =
  | { readonly resolved: true; readonly declared: DeclaredWaitKind; readonly wakeCommands: readonly CommandName[] }
  | TypedRefusal;

/**
 * Resolve one wait kind for this workshop. Fail-closed on BOTH fences:
 *   1. the kind must be one of the FIVE frozen universe kinds
 *      (an invented kind is a typed UNIVERSE_VIOLATION - mutation w);
 *   2. the kind must be one of THIS workshop's two declared legitimate
 *      waits (a frozen kind Discovery never legitimately waits on is a
 *      typed WAIT_WITHOUT_WAKE_SOURCE, never a silent stretch).
 * The wake commands come from the frozen WAITS registry (D5/D12 grammar).
 */
export function discoveryWaitOf(kind: InventedWaitKind | WaitKind): DiscoveryWaitResolution {
  const frozen = WAITS.find((entry) => entry.kind === kind);
  if (frozen === undefined) {
    return {
      refused: true,
      reason: 'UNIVERSE_VIOLATION',
      detail: `wait kind ${JSON.stringify(kind)} is not one of the five frozen kinds (invented wait kinds never enter the ledger; mutation w)`,
    };
  }
  const declared = DECLARED_WAIT_KINDS.find((entry) => entry.kind === kind);
  if (declared === undefined) {
    return {
      refused: true,
      reason: 'WAIT_WITHOUT_WAKE_SOURCE',
      detail: `wait kind ${kind} is frozen but is not a legitimate wait of this workshop (declared: ${DECLARED_WAIT_KINDS.map((entry) => entry.kind).join(', ')})`,
    };
  }
  return { resolved: true, declared, wakeCommands: [...frozen.wakeCommands] };
}
