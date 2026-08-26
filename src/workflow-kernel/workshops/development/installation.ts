/**
 * workflow-kernel/workshops/development/installation.ts - the WORKSHOP
 * SEMANTIC INTERFACE of the EK-8 conversion (WP-11V): the pure data shape
 * every converted workshop installs, plus the one generic installation
 * validator that proves an installation is DATA OVER THE FROZEN KERNEL and
 * nothing else.
 *
 * Plan EK-8 ("Convert ... to the same workshop semantic interface"):
 *   - input/output product schemas;
 *   - pure contribution mappings;
 *   - installed skills, tools and hooks;
 *   - CheckPlans and semantic gates;
 *   - idempotent effects;
 *   - typed human/external waits.
 *
 * LAWS implemented here:
 *   - A workshop installation is MANIFEST DATA. Module/package identity,
 *     product schemas, skills, tools, hooks, check rows, gate rows, effect
 *     rows and wait rows are content-addressed declarations - the kernel
 *     never branches on any of them (plan EK-8: "Keep module/package
 *     identity in installed manifests, never in kernel conditionals").
 *   - Every kernel-facing vocabulary an installation names (command,
 *     evidence kind, obligation kind, wait kind, wake command, gate
 *     verdict, effect outcome) must already exist in the frozen EK-1
 *     transition universe. An installation that needs a NEW kind is
 *     refused typed - that is a kernel widening request (an admission
 *     act), never a silent extension (the synthetic-workshop
 *     kernel-modification fence).
 *   - The gate verdict vocabulary and the effect outcome vocabulary are
 *     DERIVED from the frozen evidence registry (GateDecision:* and
 *     EffectReceipt:* kinds), never restated as a private list.
 *
 * PURITY: imports only the pure kernel domain (types + universe + digest).
 * No session, no SQL, no clock, no I/O.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { EffectOutcome, GateVerdict } from '../../domain/types.js';
import type { CommandName, EvidenceKind, WaitKind } from '../../domain/universe.js';
import {
  COMMAND_NAMES,
  EVIDENCE_KINDS,
  OBLIGATION_KINDS,
  WAIT_KINDS,
  WAITS,
} from '../../domain/universe.js';

/* ------------------------------------------------------------------ */
/* The installation data shape                                         */
/* ------------------------------------------------------------------ */

/** One product schema field declaration. */
export interface ProductFieldDeclaration {
  readonly name: string;
  readonly kind: 'string' | 'digest' | 'ref' | 'ref-list' | 'enum' | 'boolean';
  /** For kind=enum: the closed value set (data, never a kernel vocabulary). */
  readonly values?: readonly string[];
  readonly required: boolean;
}

/** One input/output product schema (content-addressed declaration). */
export interface ProductSchemaDeclaration {
  /** Workshop-namespaced schema id (e.g. workshop.<x>.<product>.v1). */
  readonly schemaId: string;
  readonly role: 'input' | 'output';
  /** Which workshop phase consumes/produces it (manifest vocabulary). */
  readonly phase: string;
  readonly fields: readonly ProductFieldDeclaration[];
}

/** One installed skill (cognition instructions; content-addressed). */
export interface SkillDeclaration {
  readonly skillId: string;
  readonly instructionsRef: string;
  readonly digest: string;
}

/** One installed tool (bounded schema summary; the contract carries the pin). */
export interface ToolDeclaration {
  readonly toolRef: string;
  readonly schemaSummary: string;
}

/** One installed hook (context injection point; content-addressed). */
export interface HookDeclaration {
  readonly event: string;
  readonly additionalContextRef: string;
  readonly digest: string;
}

/** One CheckPlan row: a named check one gate runs (R15 - manifest data). */
export interface CheckPlanRow {
  readonly checkId: string;
  /** Which gate of this workshop consumes the row. */
  readonly gate: string;
  /** machine: the kernel/driver can evaluate it; operator: only a human can. */
  readonly evaluator: 'machine' | 'operator';
  readonly contentRef: string;
  readonly digest: string;
}

/** One data-driven verdict rule of a semantic gate (ordered; first match wins). */
export interface GateVerdictRule {
  /** Check results this rule requires (all must hold / the named one must fail). */
  readonly when: { readonly checkId: string; readonly outcome: 'pass' | 'fail' | 'operator-only' };
  readonly verdict: GateVerdict;
}

/** One semantic gate declaration (CheckPlan + rules + typed wait arm). */
export interface GateDeclaration {
  readonly gateId: string;
  /** The frozen kernel command that commits the gate's decision. */
  readonly command: CommandName;
  /** Kernel evidence kinds the gate's guard already requires (verified equal to the guard set this workshop relies on). */
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  /** The full frozen verdict vocabulary (derived; equality asserted at validation). */
  readonly verdictVocabulary: readonly GateVerdict[];
  /** Optional wait arm: a verdict this gate surfaces as a typed wait. */
  readonly waitOn?: { readonly verdict: GateVerdict; readonly waitKind: WaitKind };
  readonly rules: readonly GateVerdictRule[];
}

/** One idempotent effect declaration. */
export interface EffectDeclaration {
  readonly effectId: string;
  readonly command: CommandName;
  /** Deterministic idempotency key rule (documentation string of the rule). */
  readonly idempotencyKeyRule: string;
  /** Full frozen D2 outcome vocabulary (derived; equality asserted at validation). */
  readonly outcomes: readonly EffectOutcome[];
  /** The truthful resume outcome after an operator disposition: the effect condition already held. */
  readonly idempotentResumeOutcome: 'already-applied';
  /** Kernel evidence kind the effect settles over (machine observation). */
  readonly verificationEvidenceKind: EvidenceKind;
}

/** One typed wait declaration (D5/D12 only - never an invented kind). */
export interface WaitDeclaration {
  readonly purpose: string;
  readonly kind: WaitKind;
  /** Must be a subset of the frozen registry row's declared wake commands. */
  readonly wakeCommands: readonly CommandName[];
  /** D12/Elite-2: the wake requires an operator disposition receipt. */
  readonly operatorDispositionRequired: boolean;
  readonly rationale: string;
}

/** The complete installed workshop (pure data over the frozen kernel). */
export interface WorkshopInstallation {
  readonly identity: {
    readonly workshopId: string;
    /** The lifecycle family class this workshop belongs to (a value read from the frozen role-contract manifest, never a kernel literal). */
    readonly workshopClass: string;
    readonly version: string;
    /** Installed process-module identity (module/package identity lives HERE, never in kernel conditionals). */
    readonly processModuleRef: string;
  };
  readonly products: readonly ProductSchemaDeclaration[];
  readonly installed: {
    readonly skills: readonly SkillDeclaration[];
    readonly tools: readonly ToolDeclaration[];
    readonly hooks: readonly HookDeclaration[];
  };
  readonly checkPlans: readonly CheckPlanRow[];
  readonly gates: readonly GateDeclaration[];
  readonly effects: readonly EffectDeclaration[];
  readonly waits: readonly WaitDeclaration[];
}

/* ------------------------------------------------------------------ */
/* Derived vocabularies (single source: the frozen evidence registry)  */
/* ------------------------------------------------------------------ */

/** The frozen five gate verdicts, derived from the GateDecision:* evidence kinds. */
export function gateVerdictVocabulary(): readonly GateVerdict[] {
  return EVIDENCE_KINDS
    .filter((kind) => kind.startsWith('GateDecision:'))
    .map((kind) => kind.slice('GateDecision:'.length) as GateVerdict);
}

/** The frozen seven D2 effect outcomes, derived from the EffectReceipt:* evidence kinds. */
export function effectOutcomeVocabulary(): readonly EffectOutcome[] {
  return EVIDENCE_KINDS
    .filter((kind) => kind.startsWith('EffectReceipt:'))
    .map((kind) => kind.slice('EffectReceipt:'.length) as EffectOutcome);
}

/* ------------------------------------------------------------------ */
/* The generic installation validator                                  */
/* ------------------------------------------------------------------ */

/** Typed installation refusals (closed set; fail-closed, never a guess). */
export type InstallationRefusalCode =
  | 'IDENTITY_MALFORMED'
  | 'PRODUCT_SCHEMA_MALFORMED'
  | 'INSTALLED_ARTIFACT_MALFORMED'
  | 'CHECKPLAN_MALFORMED'
  | 'GATE_COMMAND_OUTSIDE_UNIVERSE'
  | 'GATE_EVIDENCE_KIND_OUTSIDE_UNIVERSE'
  | 'GATE_VERDICT_VOCABULARY_DRIFT'
  | 'GATE_RULE_CHECK_UNKNOWN'
  | 'GATE_WAIT_KIND_OUTSIDE_UNIVERSE'
  | 'EFFECT_COMMAND_OUTSIDE_UNIVERSE'
  | 'EFFECT_OUTCOME_VOCABULARY_DRIFT'
  | 'EFFECT_EVIDENCE_KIND_OUTSIDE_UNIVERSE'
  | 'WAIT_KIND_OUTSIDE_UNIVERSE'
  | 'WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY'
  | 'WAIT_WAKE_COMMAND_OUTSIDE_UNIVERSE'
  | 'OBLIGATION_KIND_OUTSIDE_UNIVERSE';

export interface InstallationRefusal {
  readonly refused: true;
  readonly code: InstallationRefusalCode;
  readonly detail: string;
}

export type InstallationValidation =
  | { readonly valid: true; readonly installation: WorkshopInstallation }
  | InstallationRefusal;

const CONTENT_ADDRESS = /^sha256:[0-9a-f]{64}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

function refused(code: InstallationRefusalCode, detail: string): InstallationRefusal {
  return { refused: true, code, detail };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Validate one workshop installation against the FROZEN kernel: an
 * installation is valid iff every kernel-facing name it carries already
 * exists in the frozen transition universe, every vocabulary it restates
 * equals the frozen one, and every content-addressed declaration verifies.
 * A new kind anywhere is a typed refusal - the installation cannot extend
 * the kernel (the EK-8 generalization fence).
 */
export function validateWorkshopInstallation(installation: WorkshopInstallation): InstallationValidation {
  // 1. Identity.
  const id = installation.identity;
  if (
    !id || typeof id.workshopId !== 'string' || id.workshopId.length === 0
    || typeof id.workshopClass !== 'string' || id.workshopClass.length === 0
    || typeof id.version !== 'string' || id.version.length === 0
    || typeof id.processModuleRef !== 'string' || id.processModuleRef.length === 0
  ) {
    return refused('IDENTITY_MALFORMED', 'workshop identity requires workshopId, workshopClass, version and processModuleRef (module identity is manifest data)');
  }

  // 2. Product schemas: unique ids, well-formed fields, closed enum values.
  const schemaIds = new Set<string>();
  for (const schema of installation.products) {
    if (typeof schema.schemaId !== 'string' || schema.schemaId.length === 0 || schemaIds.has(schema.schemaId)) {
      return refused('PRODUCT_SCHEMA_MALFORMED', `product schema id ${String(schema?.schemaId)} is empty or duplicated`);
    }
    schemaIds.add(schema.schemaId);
    if (schema.role !== 'input' && schema.role !== 'output') {
      return refused('PRODUCT_SCHEMA_MALFORMED', `${schema.schemaId}: role must be input or output`);
    }
    if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
      return refused('PRODUCT_SCHEMA_MALFORMED', `${schema.schemaId}: a product schema declares at least one field`);
    }
    for (const field of schema.fields) {
      if (typeof field.name !== 'string' || field.name.length === 0) {
        return refused('PRODUCT_SCHEMA_MALFORMED', `${schema.schemaId}: a field name is empty`);
      }
      if (!['string', 'digest', 'ref', 'ref-list', 'enum', 'boolean'].includes(field.kind)) {
        return refused('PRODUCT_SCHEMA_MALFORMED', `${schema.schemaId}.${field.name}: unknown field kind ${String(field.kind)}`);
      }
      if (field.kind === 'enum' && (!Array.isArray(field.values) || field.values.length === 0)) {
        return refused('PRODUCT_SCHEMA_MALFORMED', `${schema.schemaId}.${field.name}: an enum field declares its closed value set`);
      }
    }
  }

  // 3. Installed artifacts: content-addressed skills and hooks.
  for (const skill of installation.installed.skills) {
    if (!CONTENT_ADDRESS.test(skill.instructionsRef) || !DIGEST_HEX.test(skill.digest)) {
      return refused('INSTALLED_ARTIFACT_MALFORMED', `skill ${String(skill?.skillId)} must be content-addressed`);
    }
  }
  for (const hook of installation.installed.hooks) {
    if (!CONTENT_ADDRESS.test(hook.additionalContextRef) || !DIGEST_HEX.test(hook.digest)) {
      return refused('INSTALLED_ARTIFACT_MALFORMED', `hook ${String(hook?.event)} must be content-addressed`);
    }
  }
  if (!Array.isArray(installation.installed.tools) || installation.installed.tools.length === 0) {
    return refused('INSTALLED_ARTIFACT_MALFORMED', 'the installed tool set is empty');
  }

  // 4. CheckPlans: content-addressed rows; operator evaluator rows are legal
  //    only where a gate declares a wait arm (the Elite-2 class).
  const checkIds = new Set(installation.checkPlans.map((row) => row.checkId));
  for (const row of installation.checkPlans) {
    if (!CONTENT_ADDRESS.test(row.contentRef) || !DIGEST_HEX.test(row.digest)) {
      return refused('CHECKPLAN_MALFORMED', `check ${String(row?.checkId)} must be content-addressed`);
    }
    if (row.evaluator !== 'machine' && row.evaluator !== 'operator') {
      return refused('CHECKPLAN_MALFORMED', `check ${row.checkId}: evaluator must be machine or operator`);
    }
  }

  // 5. Gates: frozen commands, frozen evidence kinds, EXACT verdict
  //    vocabulary equality, rules over declared checks, frozen wait kinds.
  const verdicts = gateVerdictVocabulary();
  const outcomes = effectOutcomeVocabulary();
  for (const gate of installation.gates) {
    if (!(COMMAND_NAMES as readonly string[]).includes(gate.command)) {
      return refused('GATE_COMMAND_OUTSIDE_UNIVERSE', `gate ${gate.gateId} names command ${String(gate.command)} outside the frozen 53-command universe (a new transition kind is an admission act, never installation data)`);
    }
    for (const kind of gate.requiredEvidenceKinds) {
      if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
        return refused('GATE_EVIDENCE_KIND_OUTSIDE_UNIVERSE', `gate ${gate.gateId} requires evidence kind ${String(kind)} outside the frozen registry`);
      }
    }
    if (!sameSet(gate.verdictVocabulary as readonly string[], verdicts as readonly string[])) {
      return refused('GATE_VERDICT_VOCABULARY_DRIFT', `gate ${gate.gateId} must restate EXACTLY the frozen five gate verdicts (R1), got [${(gate.verdictVocabulary ?? []).join(', ')}]`);
    }
    for (const rule of gate.rules) {
      if (!checkIds.has(rule.when.checkId)) {
        return refused('GATE_RULE_CHECK_UNKNOWN', `gate ${gate.gateId} rule references check ${rule.when.checkId} outside the installed CheckPlan`);
      }
      if (!verdicts.includes(rule.verdict)) {
        return refused('GATE_VERDICT_VOCABULARY_DRIFT', `gate ${gate.gateId} rule yields verdict ${String(rule.verdict)} outside the frozen vocabulary`);
      }
    }
    if (gate.waitOn !== undefined) {
      if (!(WAIT_KINDS as readonly string[]).includes(gate.waitOn.waitKind)) {
        return refused('GATE_WAIT_KIND_OUTSIDE_UNIVERSE', `gate ${gate.gateId} wait arm names kind ${String(gate.waitOn.waitKind)} outside the frozen wait registry (wait-kind invention)`);
      }
      if (!verdicts.includes(gate.waitOn.verdict)) {
        return refused('GATE_VERDICT_VOCABULARY_DRIFT', `gate ${gate.gateId} wait arm verdict is outside the frozen vocabulary`);
      }
    }
  }

  // 6. Effects: frozen command, EXACT D2 seven-outcome equality, frozen
  //    verification evidence kind.
  for (const effect of installation.effects) {
    if (!(COMMAND_NAMES as readonly string[]).includes(effect.command)) {
      return refused('EFFECT_COMMAND_OUTSIDE_UNIVERSE', `effect ${effect.effectId} names command ${String(effect.command)} outside the frozen universe`);
    }
    if (!sameSet(effect.outcomes as readonly string[], outcomes as readonly string[])) {
      return refused('EFFECT_OUTCOME_VOCABULARY_DRIFT', `effect ${effect.effectId} must restate EXACTLY the frozen seven D2 outcomes, got [${(effect.outcomes ?? []).join(', ')}]`);
    }
    if (effect.idempotentResumeOutcome !== 'already-applied') {
      return refused('EFFECT_OUTCOME_VOCABULARY_DRIFT', `effect ${effect.effectId}: the idempotent resume outcome is always already-applied`);
    }
    if (!(EVIDENCE_KINDS as readonly string[]).includes(effect.verificationEvidenceKind)) {
      return refused('EFFECT_EVIDENCE_KIND_OUTSIDE_UNIVERSE', `effect ${effect.effectId} verification evidence ${String(effect.verificationEvidenceKind)} is outside the frozen registry`);
    }
  }

  // 7. Waits: frozen kinds only, wake commands inside the frozen registry
  //    row for that kind (D5/D12 discipline - no invented wake source).
  for (const wait of installation.waits) {
    if (!(WAIT_KINDS as readonly string[]).includes(wait.kind)) {
      return refused('WAIT_KIND_OUTSIDE_UNIVERSE', `wait ${wait.purpose} names kind ${String(wait.kind)} outside the frozen five-kind registry (wait-kind invention)`);
    }
    const registryRow = WAITS.find((row) => row.kind === wait.kind);
    if (registryRow === undefined) {
      return refused('WAIT_KIND_OUTSIDE_UNIVERSE', `wait ${wait.purpose} kind ${String(wait.kind)} has no frozen registry row`);
    }
    for (const wake of wait.wakeCommands) {
      if (!(COMMAND_NAMES as readonly string[]).includes(wake)) {
        return refused('WAIT_WAKE_COMMAND_OUTSIDE_UNIVERSE', `wait ${wait.purpose} wake command ${String(wake)} is outside the frozen command universe`);
      }
      if (!(registryRow.wakeCommands as readonly string[]).includes(wake)) {
        return refused('WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY', `wait ${wait.purpose} wake command ${wake} is not a declared wake source of ${wait.kind} in the frozen registry`);
      }
    }
    if (wait.operatorDispositionRequired && wait.wakeCommands.length === 0) {
      return refused('WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY', `wait ${wait.purpose} requires an operator disposition but declares no wake command`);
    }
  }

  return { valid: true, installation };
}

/** Result of the obligation-kind membership check. */
export type ObligationKindAssertion =
  | { readonly ok: true }
  | InstallationRefusal;

/**
 * Validate that every obligation kind a workshop names (role-contract
 * evidenceObligations, manifest routing rows) exists in the frozen
 * obligation registry. Used by the role-binding layer and the synthetic
 * generalization fence: a new obligation kind is a kernel widening, never
 * installation data.
 */
export function assertObligationKindsInstalled(kinds: readonly string[], owner: string): ObligationKindAssertion {
  for (const kind of kinds) {
    if (!(OBLIGATION_KINDS as readonly string[]).includes(kind)) {
      return refused('OBLIGATION_KIND_OUTSIDE_UNIVERSE', `${owner} names obligation kind ${String(kind)} outside the frozen registry (a new obligation kind is a kernel widening, never installation data)`);
    }
  }
  return { ok: true };
}

/** The canonical digest of one declaration row (the content-address rule). */
export function declarationDigest(declaration: unknown): string {
  return sha256OfCanonical(declaration);
}
