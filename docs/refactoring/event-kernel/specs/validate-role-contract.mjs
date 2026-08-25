#!/usr/bin/env node
/**
 * validate-role-contract.mjs — WP-16 part 2 validator (EK-1 admission spec: role contract).
 *
 * Validates:
 *   1. docs/refactoring/event-kernel/specs/role-contract-manifest.json against the
 *      normative $defs/Manifest of canonical-role-contract.schema.json (draft 2020-12
 *      subset, implemented below with zero dependencies) PLUS the semantic admission
 *      rules: finite role universe with exact equality coverage, one row per launch
 *      kind, zero duplicate binding, zero fallback, deterministic EK-8 pending slots,
 *      semantic-profile consistency per (cellKind, protocolRole), and manifestDigest
 *      verification under the frozen canonicalization rule.
 *   2. A MINIATURE synthetic CanonicalRoleContract instance for the author profile
 *      (launch kind discovery.implementation.author): schema-valid, self-addressing,
 *      every paired content digest verified, route policy yields exactly one match.
 *   3. --mutations: four deliberate RED mutations (row removal, duplicate binding,
 *      arbitrary contract field, executable route rule). Each must make this
 *      validator fail; exit code 0 iff ALL FOUR go RED.
 *
 * Determinism: no timestamps, no absolute paths, no randomness. Running twice on
 * the same tree prints byte-identical output.
 *
 * Usage:
 *   node docs/refactoring/event-kernel/specs/validate-role-contract.mjs
 *   node docs/refactoring/event-kernel/specs/validate-role-contract.mjs --mutations
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPECS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(SPECS_DIR, 'canonical-role-contract.schema.json');
const MANIFEST_PATH = path.join(SPECS_DIR, 'role-contract-manifest.json');

// ---------------------------------------------------------------------------
// Frozen canonicalization + slot-fingerprint rule (ROLE-CONTRACT-SPEC.md).
// ---------------------------------------------------------------------------

/** Recursively sort object keys (lexicographic by UTF-16 code unit; JS default). */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }
  return value;
}

/** Canonical JSON: recursively key-sorted, compact JSON.stringify, UTF-8. */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** sha256 hex of the canonical JSON of the value minus the excluded top-level keys. */
function digestExcluding(value, excludedKeys) {
  const copy = {};
  for (const key of Object.keys(value)) {
    if (!excludedKeys.includes(key)) copy[key] = value[key];
  }
  return createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
}

/** contractDigest = sha256(canonicalJson(contract minus {contractDigest, roleContractRef})). */
export function contractDigestOf(contract) {
  return digestExcluding(contract, ['contractDigest', 'roleContractRef']);
}

/** Same rule for the D4 certifier operator contract (operatorContractRef is derived). */
export function operatorContractDigestOf(contract) {
  return digestExcluding(contract, ['contractDigest', 'operatorContractRef']);
}

/** manifestDigest = sha256(canonicalJson(manifest minus manifestDigest)). */
export function manifestDigestOf(manifest) {
  return digestExcluding(manifest, ['manifestDigest']);
}

// ---------------------------------------------------------------------------
// Minimal draft-2020-12 subset checker (zero dependencies).
// Supported keywords: $ref (local #/$defs/X only), type (string or array),
// const, enum, pattern, minLength, minItems, maxItems, uniqueItems,
// minProperties, properties, required, additionalProperties, items.
// Annotation keywords (title/description/$comment/$id/$schema/$defs) ignored.
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function resolveRef(ref, root) {
  const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!match) throw new Error(`UNSUPPORTED_REF (only local #/$defs/X): ${ref}`);
  const target = root.$defs && root.$defs[match[1]];
  if (!target) throw new Error(`UNRESOLVED_REF: ${ref}`);
  return target;
}

function checkType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: throw new Error(`UNSUPPORTED_TYPE: ${type}`);
  }
}

/**
 * Validate value against schema. Appends `path: message` strings to errors.
 * Returns nothing; callers test errors.length.
 */
function validateSchema(value, schema, root, instancePath, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${instancePath}: schema forbids any value`);
    return;
  }
  if (typeof schema.$ref === 'string') {
    validateSchema(value, resolveRef(schema.$ref, root), root, instancePath, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => checkType(value, t))) {
      errors.push(`${instancePath}: expected type ${JSON.stringify(schema.type)}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
      return; // further keywords assume the declared type
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${instancePath}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(value, option))) {
    errors.push(`${instancePath}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${instancePath}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${instancePath}: string shorter than minLength ${schema.minLength}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${instancePath}: array has ${value.length} items, minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${instancePath}: array has ${value.length} items, maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems) {
      const seen = [];
      for (const item of value) {
        if (seen.some((other) => deepEqual(item, other))) {
          errors.push(`${instancePath}: array items not unique (duplicate ${canonicalJson(item).slice(0, 60)})`);
          break;
        }
        seen.push(item);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        validateSchema(item, schema.items, root, `${instancePath}[${index}]`, errors);
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${instancePath}: object has ${Object.keys(value).length} properties, minProperties ${schema.minProperties}`);
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(properties)) {
      if (key in value) {
        validateSchema(value[key], properties[key], root, `${instancePath}.${key}`, errors);
      }
    }
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push(`${instancePath}: missing required property "${key}"`);
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${instancePath}: additional property "${key}" is forbidden (closed shape; adding fields reopens EK-1)`);
        }
      }
    } else if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          validateSchema(value[key], schema.additionalProperties, root, `${instancePath}.${key}`, errors);
        }
      }
    }
  }
}

function validateAgainst(schemaDoc, value, subschema, label, errors) {
  validateSchema(value, subschema, schemaDoc, label, errors);
}

// ---------------------------------------------------------------------------
// Route-policy selection law: finite universe => exactly-one-match is decidable.
// ---------------------------------------------------------------------------

export function matchingRuleCount(table, launch) {
  let count = 0;
  for (const rule of table.rules) {
    const when = rule.when;
    let ok = true;
    for (const key of Object.keys(when)) {
      if (when[key] !== launch[key]) {
        ok = false;
        break;
      }
    }
    if (ok) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Semantic manifest admission rules.
// ---------------------------------------------------------------------------

const SEMANTIC_PROFILE_BY_CELL = {
  'implementation.author': 'implementer',
  'implementation.reviewer': 'reviewer',
  'planning.author': 'planner',
  'planning.reviewer': 'reviewer',
};

function deriveExpectedLaunchKinds(manifest) {
  const expected = new Set();
  for (const workshop of manifest.workshops) {
    expected.add(`${workshop}.implementation.author`);
    expected.add(`${workshop}.implementation.reviewer`);
  }
  for (const workshop of manifest.planningCellWorkshops) {
    expected.add(`${workshop}.planning.author`);
    expected.add(`${workshop}.planning.reviewer`);
  }
  return expected;
}

/**
 * Full manifest admission check (structure + semantics). Returns array of
 * error strings; empty means GREEN.
 */
export function checkManifest(schemaDoc, manifest, options = {}) {
  const errors = [];

  // 1. Structural: manifest must satisfy the normative $defs/Manifest.
  validateAgainst(schemaDoc, manifest, { $ref: '#/$defs/Manifest' }, 'manifest', errors);

  // 2. Finite role universe: exact closed enums (schema-const already, but
  //    assert the finiteness claim explicitly for the receipt).
  const universe = manifest.roleUniverse;
  if (canonicalJson(universe.protocolRoles) !== canonicalJson(['author', 'reviewer'])) {
    errors.push('roleUniverse.protocolRoles must be exactly ["author","reviewer"]');
  }
  if (canonicalJson(universe.semanticProfiles) !== canonicalJson(['planner', 'implementer', 'reviewer', 'certifier'])) {
    errors.push('roleUniverse.semanticProfiles must be exactly the four frozen profiles');
  }
  if (manifest.fallbackPolicy !== 'none') {
    errors.push('fallbackPolicy must be "none"');
  }

  // 3. Coverage equality: derived expected set == actual bindings set.
  const expected = deriveExpectedLaunchKinds(manifest);
  const actual = new Set(manifest.bindings.map((row) => row.launchKind));
  for (const missing of [...expected].filter((k) => !actual.has(k)).sort()) {
    errors.push(`coverage: launch kind "${missing}" is required by the declared universe but has no binding row`);
  }
  for (const extra of [...actual].filter((k) => !expected.has(k)).sort()) {
    errors.push(`coverage: launch kind "${k}" has a binding row but is not in the declared universe`);
  }

  // 4. Uniqueness: launch kind, dimension tuple, slot ref — zero duplicates.
  const seenLaunchKind = new Set();
  const seenTuple = new Set();
  const seenSlotRef = new Set();
  for (const row of manifest.bindings) {
    if (seenLaunchKind.has(row.launchKind)) {
      errors.push(`uniqueness: duplicate binding for launch kind "${row.launchKind}"`);
    }
    seenLaunchKind.add(row.launchKind);
    const tuple = [row.workshop, row.cellKind, row.protocolRole, row.semanticProfile].join('|');
    if (seenTuple.has(tuple)) {
      errors.push(`uniqueness: duplicate dimension tuple "${tuple}"`);
    }
    seenTuple.add(tuple);
    if (seenSlotRef.has(row.slot.roleContractRef)) {
      errors.push(`uniqueness: two rows share slot ref "${row.slot.roleContractRef}"`);
    }
    seenSlotRef.add(row.slot.roleContractRef);
  }

  for (const row of manifest.bindings) {
    // 5. launchKind composition rule.
    const composed = `${row.workshop}.${row.cellKind}.${row.protocolRole}`;
    if (row.launchKind !== composed) {
      errors.push(`composition: launchKind "${row.launchKind}" != "${composed}"`);
    }
    // 6. Semantic-profile consistency per (cellKind, protocolRole).
    const expectedProfile = SEMANTIC_PROFILE_BY_CELL[`${row.cellKind}.${row.protocolRole}`];
    if (expectedProfile === undefined) {
      errors.push(`profile map: no frozen semantic profile for (${row.cellKind}, ${row.protocolRole})`);
    } else if (row.semanticProfile !== expectedProfile) {
      errors.push(`profile map: (${row.cellKind}, ${row.protocolRole}) must bind profile "${expectedProfile}", got "${row.semanticProfile}"`);
    }
    // 7. Deterministic pending slot: zero accidental pre-binding, zero crossed binding.
    if (row.slot.roleContractRef !== `ek8:pending:${row.launchKind}`) {
      errors.push(`slot: launch kind "${row.launchKind}" must pin placeholder "ek8:pending:${row.launchKind}", got "${row.slot.roleContractRef}"`);
    }
    if (row.slot.contractDigest !== 'pending-ek8') {
      errors.push(`slot: launch kind "${row.launchKind}" digest must be "pending-ek8", got "${row.slot.contractDigest}"`);
    }
  }

  // 8. Planning cells only where declared.
  for (const row of manifest.bindings) {
    if (row.cellKind === 'planning' && !manifest.planningCellWorkshops.includes(row.workshop)) {
      errors.push(`planning: planning row for workshop "${row.workshop}" but workshop not in planningCellWorkshops`);
    }
  }

  // 9. Operator contract: exactly one, frozen D4 binding.
  if (manifest.operatorContracts.length !== 1) {
    errors.push(`operatorContracts: expected exactly 1 row, got ${manifest.operatorContracts.length}`);
  } else {
    const op = manifest.operatorContracts[0];
    if (op.ownedCommand !== 'lifecycleRun.verifyTerminalClaims') {
      errors.push(`operatorContracts[0]: ownedCommand must be lifecycleRun.verifyTerminalClaims (D4)`);
    }
    if (op.ownerAggregate !== 'LifecycleRun') {
      errors.push(`operatorContracts[0]: ownerAggregate must be LifecycleRun (D4)`);
    }
    if (op.semanticProfile !== 'certifier') {
      errors.push(`operatorContracts[0]: semanticProfile must be certifier`);
    }
    if (op.slot.roleContractRef !== `ek8:pending:${op.launchKind}` || op.slot.contractDigest !== 'pending-ek8') {
      errors.push(`operatorContracts[0]: slot must be the deterministic pending placeholder`);
    }
  }

  // 10. Dimensional coverage: both protocol roles used in every workshop;
  //     all four semantic profiles used across the manifest.
  for (const workshop of manifest.workshops) {
    for (const role of ['author', 'reviewer']) {
      const covered = manifest.bindings.some((r) => r.workshop === workshop && r.protocolRole === role);
      if (!covered) {
        errors.push(`dimensional coverage: workshop "${workshop}" has no ${role} binding`);
      }
    }
  }
  const profilesUsed = new Set([
    ...manifest.bindings.map((r) => r.semanticProfile),
    ...manifest.operatorContracts.map((o) => o.semanticProfile),
  ]);
  for (const profile of universe.semanticProfiles) {
    if (!profilesUsed.has(profile)) {
      errors.push(`dimensional coverage: semantic profile "${profile}" is never bound`);
    }
  }

  // 11. Zero fallback: no binding may be conditioned on any forbidden source;
  //     structurally the rows cannot carry conditions at all (closed shape),
  //     so the check is the declared policy + the absence of any "fallback"
  //     key anywhere in the serialized manifest.
  if (/fallback/i.test(JSON.stringify(manifest).replace(/"fallbackPolicy":"none"/g, ''))) {
    errors.push('zero-fallback: manifest text mentions a fallback outside the frozen fallbackPolicy:"none" declaration');
  }

  // 12. manifestDigest (skippable for mutation harnesses that recompute it).
  if (!options.skipDigest) {
    const computed = manifestDigestOf(manifest);
    if (manifest.manifestDigest !== computed) {
      errors.push(`manifestDigest: stored ${manifest.manifestDigest} != computed ${computed}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Synthetic miniature example: author profile contract for
// discovery.implementation.author (the EK-8 slot the census RR-8/RR-10
// retain-and-move seeds eventually fill with real content).
// ---------------------------------------------------------------------------

export function buildSyntheticExample() {
  const protocolSkill = {
    schemaVersion: 'ek.skill-artifact.ek1.v1',
    skillId: 'synthetic-protocol',
    instructions: 'Synthetic cognition-only execution-protocol instructions (miniature example).',
  };
  const semanticSkill = {
    schemaVersion: 'ek.skill-artifact.ek1.v1',
    skillId: 'synthetic-semantic-author',
    instructions: 'Synthetic cognition-only author-profile semantic instructions (miniature example).',
  };
  const semanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'implementer',
    definitionSummary: 'Produces cell material against pinned product contracts.',
  };
  const routePolicyTable = {
    schemaVersion: 'ek.executor-route-policy.ek1.v1',
    tableId: 'synthetic.route-table.discovery-implementation-author',
    rules: [
      {
        when: { launchKind: 'discovery.implementation.author' },
        route: { transportKind: 'opencode', provider: 'synthetic-provider', model: 'synthetic-model-1', effort: null },
      },
    ],
  };
  const completionCommandSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      contributionRef: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    },
    required: ['contributionRef'],
    additionalProperties: false,
  };
  const trackerProfile = {
    schemaVersion: 'ek.tracker-projection-profile.ek1.v1',
    profileId: 'synthetic.tracker.discovery-implementation-author',
    display: {
      label: 'Discovery author',
      boardColumn: 'in-progress',
      detailSections: ['role-contract', 'prompt-receipt'],
    },
  };
  // PromptBudgetProfile artifact shape is frozen by WP-16 part 3; here a
  // synthetic stand-in value is content-addressed for the paired digest only.
  const promptBudgetStandIn = 'synthetic-prompt-budget-profile-stand-in (shape frozen by WP-16 part 3)';

  const d = (artifact) => createHash('sha256').update(canonicalJson(artifact), 'utf8').digest('hex');
  const ref = (artifact) => `sha256:${d(artifact)}`;

  const launch = { launchKind: 'discovery.implementation.author', protocolRole: 'author', semanticProfile: 'implementer' };

  const contract = {
    schemaVersion: 'ek.canonical-role-contract.ek1.v1',
    roleContractRef: 'PENDING', // derived below
    protocolRole: launch.protocolRole,
    semanticProfileRef: ref(semanticProfileArtifact),
    protocolSkillRef: ref(protocolSkill),
    protocolSkillDigest: d(protocolSkill),
    semanticSkillRef: ref(semanticSkill),
    semanticSkillDigest: d(semanticSkill),
    executorRoutePolicyRef: ref(routePolicyTable),
    executorRoutePolicyDigest: d(routePolicyTable),
    allowedCapabilityRefs: ['cognition.provider-request', 'material.read'],
    allowedToolRefs: ['saga-board', 'fs:read'],
    inputProductContracts: [ref({ synthetic: 'discovery-brief-input-contract.v0' })],
    outputProductContracts: [ref({ synthetic: 'discovery-proposal-output-contract.v0' })],
    evidenceObligations: ['obligation:presentCandidates'],
    completionCommandSchemaRef: ref(completionCommandSchema),
    completionCommandSchemaDigest: d(completionCommandSchema),
    trackerProjectionProfileRef: ref(trackerProfile),
    trackerProjectionProfileDigest: d(trackerProfile),
    promptBudgetProfileRef: ref(promptBudgetStandIn),
    promptBudgetProfileDigest: d(promptBudgetStandIn),
    contractDigest: 'PENDING', // computed below
  };
  const digest = contractDigestOf(contract);
  contract.contractDigest = digest;
  contract.roleContractRef = `sha256:${digest}`;

  const certifierOperatorContract = {
    schemaVersion: 'ek.certifier-operator-contract.ek1.v1',
    operatorContractRef: 'PENDING',
    ownedCommand: 'lifecycleRun.verifyTerminalClaims',
    ownerAggregate: 'LifecycleRun',
    executableVerifierRefs: [ref({ synthetic: 'terminal-claim-verifier.v0' })],
    inputProductContracts: [
      ref({ synthetic: 'terminal-lifecycle-claim-contract.v0' }),
      ref({ synthetic: 'construction-surface-contract.v0' }),
    ],
    outputProductContracts: [ref({ synthetic: 'executable-verifier-result-contract.v0' })],
    evidenceObligations: ['obligation:verifyTerminalClaims'],
    contractDigest: 'PENDING',
  };
  const opDigest = operatorContractDigestOf(certifierOperatorContract);
  certifierOperatorContract.contractDigest = opDigest;
  certifierOperatorContract.operatorContractRef = `sha256:${opDigest}`;

  return {
    launch,
    contract,
    certifierOperatorContract,
    artifacts: {
      protocolSkill,
      semanticSkill,
      semanticProfileArtifact,
      routePolicyTable,
      completionCommandSchema,
      trackerProfile,
    },
  };
}

export function checkExample(schemaDoc, example) {
  const errors = [];
  const { contract, artifacts, launch, certifierOperatorContract } = example;

  // Root: the contract instance must satisfy the frozen CanonicalRoleContract shape.
  validateSchema(contract, schemaDoc, schemaDoc, 'example.contract', errors);
  // Referenced artifact shapes.
  validateAgainst(schemaDoc, artifacts.protocolSkill, { $ref: '#/$defs/SkillArtifact' }, 'example.protocolSkill', errors);
  validateAgainst(schemaDoc, artifacts.semanticSkill, { $ref: '#/$defs/SkillArtifact' }, 'example.semanticSkill', errors);
  validateAgainst(schemaDoc, artifacts.semanticProfileArtifact, { $ref: '#/$defs/SemanticProfileArtifact' }, 'example.semanticProfile', errors);
  validateAgainst(schemaDoc, artifacts.routePolicyTable, { $ref: '#/$defs/ExecutorRoutePolicyTable' }, 'example.routePolicyTable', errors);
  validateAgainst(schemaDoc, artifacts.completionCommandSchema, { $ref: '#/$defs/CompletionCommandSchema' }, 'example.completionCommandSchema', errors);
  validateAgainst(schemaDoc, artifacts.trackerProfile, { $ref: '#/$defs/TrackerProjectionProfile' }, 'example.trackerProfile', errors);
  validateAgainst(schemaDoc, certifierOperatorContract, { $ref: '#/$defs/CertifierOperatorContract' }, 'example.certifierOperatorContract', errors);

  // Self-addressing + paired digests.
  if (contract.roleContractRef !== `sha256:${contract.contractDigest}`) {
    errors.push('example.contract: roleContractRef must equal "sha256:"+contractDigest');
  }
  if (contract.contractDigest !== contractDigestOf(contract)) {
    errors.push('example.contract: contractDigest does not verify under the slot-fingerprint rule');
  }
  if (certifierOperatorContract.operatorContractRef !== `sha256:${certifierOperatorContract.contractDigest}`) {
    errors.push('example.certifierOperatorContract: operatorContractRef must equal "sha256:"+contractDigest');
  }
  if (certifierOperatorContract.contractDigest !== operatorContractDigestOf(certifierOperatorContract)) {
    errors.push('example.certifierOperatorContract: contractDigest does not verify');
  }
  const d = (artifact) => createHash('sha256').update(canonicalJson(artifact), 'utf8').digest('hex');
  const pairs = [
    ['protocolSkill', artifacts.protocolSkill, contract.protocolSkillRef, contract.protocolSkillDigest],
    ['semanticSkill', artifacts.semanticSkill, contract.semanticSkillRef, contract.semanticSkillDigest],
    ['executorRoutePolicy', artifacts.routePolicyTable, contract.executorRoutePolicyRef, contract.executorRoutePolicyDigest],
    ['completionCommandSchema', artifacts.completionCommandSchema, contract.completionCommandSchemaRef, contract.completionCommandSchemaDigest],
    ['trackerProjectionProfile', artifacts.trackerProfile, contract.trackerProjectionProfileRef, contract.trackerProjectionProfileDigest],
  ];
  for (const [name, artifact, refValue, digestValue] of pairs) {
    if (refValue !== `sha256:${d(artifact)}`) {
      errors.push(`example.${name}: ref does not match artifact content address`);
    }
    if (digestValue !== d(artifact)) {
      errors.push(`example.${name}: paired digest does not verify`);
    }
  }

  // Route-policy selection law: exactly one rule matches the launch kind.
  const matches = matchingRuleCount(artifacts.routePolicyTable, launch);
  if (matches !== 1) {
    errors.push(`example.routePolicyTable: expected exactly 1 matching rule for ${launch.launchKind}, got ${matches}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Deliberate RED mutations (documented in ROLE-CONTRACT-SPEC.md).
// Each mutation is applied to an in-memory clone; the manifest digest is
// recomputed for manifest mutations so the ONLY thing that can go red is the
// admission rule itself (an attacker who "fixes" the digest still fails).
// ---------------------------------------------------------------------------

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runMutation(name, mutate, runChecks) {
  try {
    const errors = runChecks(mutate());
    if (errors.length === 0) {
      return { name, red: false, detail: 'MUTATION SURVIVED (validator stayed green)' };
    }
    return { name, red: true, detail: errors[0] };
  } catch (error) {
    return { name, red: true, detail: `threw: ${error.message}` };
  }
}

export function runMutations(schemaDoc, manifest) {
  const results = [];

  // M1 — remove a manifest row (documentation.implementation.reviewer):
  // coverage equality must go RED.
  results.push(runMutation(
    'M1 remove-manifest-row',
    () => {
      const mutated = clone(manifest);
      mutated.bindings = mutated.bindings.filter((r) => r.launchKind !== 'documentation.implementation.reviewer');
      mutated.manifestDigest = manifestDigestOf(mutated);
      return mutated;
    },
    (mutated) => checkManifest(schemaDoc, mutated, { skipDigest: true }),
  ));

  // M2 — duplicate a binding (second row for development.planning.author):
  // uniqueness must go RED.
  results.push(runMutation(
    'M2 duplicate-binding',
    () => {
      const mutated = clone(manifest);
      const original = mutated.bindings.find((r) => r.launchKind === 'development.planning.author');
      mutated.bindings.push(clone(original));
      mutated.manifestDigest = manifestDigestOf(mutated);
      return mutated;
    },
    (mutated) => checkManifest(schemaDoc, mutated, { skipDigest: true }),
  ));

  // M3 — add an arbitrary field to the example contract (extension bag):
  // closed shape must go RED.
  results.push(runMutation(
    'M3 arbitrary-contract-field',
    () => {
      const example = buildSyntheticExample();
      example.contract.metadata = { note: 'extension bag' };
      return example;
    },
    (mutated) => checkExample(schemaDoc, mutated),
  ));

  // M4 — executable route rule (a "code" key on a route rule):
  // the declarative-table ban must go RED.
  results.push(runMutation(
    'M4 executable-route-rule',
    () => {
      const example = buildSyntheticExample();
      example.artifacts.routePolicyTable.rules[0].route.code
        = 'module.exports = (ctx) => pickByStatus(ctx.task.status)';
      return example;
    },
    (mutated) => checkExample(schemaDoc, mutated),
  ));

  return results;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function main() {
  const schemaDoc = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const runMutationsOnly = process.argv.includes('--mutations');

  const lines = [];
  if (!runMutationsOnly) {
    const manifestErrors = checkManifest(schemaDoc, manifest);
    const example = buildSyntheticExample();
    const exampleErrors = checkExample(schemaDoc, example);

    lines.push(`schema: canonical-role-contract.schema.json (draft 2020-12)`);
    lines.push(`manifest: role-contract-manifest.json`);
    lines.push(`manifestDigest: ${manifest.manifestDigest}`);
    lines.push(`workplace bindings: ${manifest.bindings.length}`);
    lines.push(`operator contracts: ${manifest.operatorContracts.length}`);
    lines.push(`expected coverage (derived): ${deriveExpectedLaunchKinds(manifest).size}`);
    lines.push(`example contract (discovery.implementation.author):`);
    lines.push(`  contractDigest: ${example.contract.contractDigest}`);
    lines.push(`  roleContractRef: ${example.contract.roleContractRef}`);
    lines.push(`  route matches for launch kind: ${matchingRuleCount(example.artifacts.routePolicyTable, example.launch)}`);
    lines.push(`example certifier operator contract (D4):`);
    lines.push(`  contractDigest: ${example.certifierOperatorContract.contractDigest}`);
    lines.push(`manifest errors: ${manifestErrors.length}`);
    for (const error of manifestErrors) lines.push(`  RED manifest: ${error}`);
    lines.push(`example errors: ${exampleErrors.length}`);
    for (const error of exampleErrors) lines.push(`  RED example: ${error}`);
    const green = manifestErrors.length === 0 && exampleErrors.length === 0;
    lines.push(`RESULT: ${green ? 'GREEN' : 'RED'}`);
    console.log(lines.join('\n'));
    process.exitCode = green ? 0 : 1;
    return;
  }

  const results = runMutations(schemaDoc, manifest);
  let allRed = true;
  for (const result of results) {
    lines.push(`${result.name}: ${result.red ? 'RED (killed)' : 'GREEN (SURVIVED)'}`);
    lines.push(`  trigger: ${result.detail}`);
    if (!result.red) allRed = false;
  }
  lines.push(`RESULT: ${allRed ? 'ALL MUTATIONS RED' : 'MUTATION SURVIVED'}`);
  console.log(lines.join('\n'));
  process.exitCode = allRed ? 0 : 1;
}

main();
