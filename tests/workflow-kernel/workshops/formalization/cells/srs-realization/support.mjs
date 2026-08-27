/**
 * support.mjs - FRF-WP08 SRS scenario-realization cell test support: the
 * dist import path, the GREEN fixture accessors and the DELIBERATE RED
 * mutation builders (each names the law it breaks; provenance: plan
 * FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN, "Elite and simple-server
 * kill tests" and "Required semantic mutations", FRF-8 phase rows).
 *
 * The kill builders mutate the GREEN fixture only (never production state);
 * every kill is asserted to be REFUSED typed by the suite, never silent.
 */
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))));

export const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

export const cell = await dist('workflow-kernel/workshops/formalization/cells/srs-realization/index.js');
export const gates = await dist('workflow-kernel/workshops/formalization/gates.js');
export const manifest = await dist('workflow-kernel/workshops/formalization/manifest.js');

export const docsPath = (relative) => join(REPO_ROOT, 'docs', relative);
export const rootPath = (relative) => join(REPO_ROOT, relative);

/* ------------------------------------------------------------------ */
/* The GREEN fixture                                                   */
/* ------------------------------------------------------------------ */

/** The green Elite fixture: universe, draft, parsed section, sealed contract. */
export function greenFixture() {
  const universe = cell.eliteUniverse();
  const draft = cell.eliteRealizationDraft();
  const assembly = cell.eliteArchitectureContract();
  return { universe, draft, section: assembly.section, contract: assembly.product };
}

/* ------------------------------------------------------------------ */
/* Deliberate RED mutation builders (payload-level kill material)       */
/* ------------------------------------------------------------------ */

const interactiveEntryOf = (draft) => draft.realizationEntries.find((entry) => entry.scenarioRef === 'uc:elite-interactive');
const mapInteractive = (draft, mapper) => ({
  ...draft,
  realizationEntries: draft.realizationEntries.map((entry) => (entry === interactiveEntryOf(draft) ? mapper(entry) : entry)),
});

/** ELITE KILL 1 (plan: "remove the browser bootstrap; reject"): the entrypoint surface required by the interactive scenario's realization is absent from the architecture contract. */
export const killMissingEntrypoint = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.filter((surface) => surface.surfaceId !== 'arch:elite-browser-bootstrap'),
});

/** ELITE KILL 1b: a required implementation/integration surface absent from the contract (the evidence harness). */
export const killMissingImplementationSurface = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.filter((surface) => surface.surfaceId !== 'arch:elite-test-harness'),
});

/** ELITE KILL 2 (plan: a declared composition surface realizing NO scenario): the orphan composer. */
export const killMissingComposition = (g) => ({
  ...g.draft,
  surfaces: [...g.draft.surfaces, { surfaceId: 'arch:orphan-composer', surfaceKind: 'composition', description: 'A composition surface realizing no scenario.', realizedScenarioRefs: [] }],
});

/** Plan: "Remove the input-to-controller runtime edge; reject." */
export const killRemovedInputToControllerEdge = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  runtimeEdges: entry.runtimeEdges.filter((edge) => !(edge.fromSurfaceRef === 'arch:elite-http-server' && edge.toSurfaceRef === 'arch:elite-input-controller')),
}));

/** Plan: "Remove the state-to-renderer runtime edge; reject." */
export const killRemovedStateToRendererEdge = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  runtimeEdges: entry.runtimeEdges.filter((edge) => !(edge.fromSurfaceRef === 'arch:elite-state-store' && edge.toSurfaceRef === 'arch:elite-renderer')),
}));

/** Plan: "Remove the composition owner; reject." */
export const killRemovedCompositionOwner = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.filter((surface) => surface.surfaceId !== 'arch:elite-composition-owner'),
});

/** Plan: required UC with no SRS realization ("Strip scenario realization from SRS"). */
export const killCoverageGap = (g) => ({
  ...g.draft,
  realizationEntries: g.draft.realizationEntries.filter((entry) => entry.scenarioRef !== 'uc:elite-batch'),
});

/** A realized scenario outside the frozen scenario id set (FOREIGN_LINEAGE). */
export const killForeignScenario = (g) => ({
  ...g.draft,
  realizationEntries: g.draft.realizationEntries.map((entry) => (entry.scenarioRef === 'uc:elite-api' ? { ...entry, scenarioRef: 'uc:foreign-run-1' } : entry)),
});

/** An evidence binding outside the frozen evidence-binding id set. */
export const killForeignEvidence = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  evidenceBinding: { ...entry.evidenceBinding, evidenceBindingRef: 'ev:foreign-evidence-1' },
}));

/** A scenario realized twice under a fresh entry id (plan FRF-8: every frozen required UC exactly once). */
export const killDuplicateRealization = (g) => ({
  ...g.draft,
  realizationEntries: [...g.draft.realizationEntries, { ...JSON.parse(JSON.stringify(interactiveEntryOf(g.draft))), realizationEntryId: 'realization:elite-interactive-double' }],
});

/** A duplicated realization entry id (double emission). */
export const killDuplicateEntryId = (g) => ({
  ...g.draft,
  realizationEntries: [...g.draft.realizationEntries, { ...JSON.parse(JSON.stringify(interactiveEntryOf(g.draft))), scenarioRef: 'uc:elite-batch' }],
});

/** A stale WHAT baseline pin (the SRS derives from the frozen baseline only). */
export const killStaleBaselinePin = (g) => ({
  ...g.draft,
  lineage: { ...g.draft.lineage, baselineRef: 'sha256:' + 'ab'.repeat(32) },
});

/** A surface claiming a scenario whose realization does not cite it back. */
export const killFalseSurfaceClaim = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.map((surface) => (surface.surfaceId === 'arch:elite-renderer' ? { ...surface, realizedScenarioRefs: [...surface.realizedScenarioRefs, 'uc:elite-api'] } : surface)),
});

/** A composition owner that is not a composition surface. */
export const killOwnerWrongKind = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.map((surface) => (surface.surfaceId === 'arch:elite-composition-owner' ? { ...surface, surfaceKind: 'infrastructure' } : surface)),
});

/** An entrypoint that is not a participating surface (disconnected). */
export const killEntrypointNotParticipating = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  participatingSurfaceRefs: entry.participatingSurfaceRefs.filter((ref) => ref !== 'arch:elite-browser-bootstrap'),
}));

/** A tampered realization digest. */
export const killTamperedRealizationDigest = (g) => {
  const parsed = cell.parseSrsRealizationDraft(g.draft);
  return { ...parsed.section, realizationDigest: 'f'.repeat(64) };
};

/** A contract pinned to a stale SRS revision. */
export const killStaleSrsRevisionPin = (g) => ({
  ...g.contract,
  lineage: { ...g.contract.lineage, srsRevisionDigest: 'cd'.repeat(32) },
});

/** WHAT-side material inside the architecture contract (desk-scope fence). */
export const killScopeViolation = (g) => ({ ...g.contract, acceptanceCriteria: [{ criterionId: 'ac:elite-1' }] });

/** A tampered postFreeze block (the WP03 seam exposure). */
export const killTamperedPostFreeze = (g) => ({
  ...g.contract,
  postFreeze: { ...g.contract.postFreeze, realizationEntryIds: [...g.contract.postFreeze.realizationEntryIds, 'realization:ghost'] },
});

/** A tampered developmentObligations block. */
export const killTamperedObligations = (g) => ({
  ...g.contract,
  developmentObligations: { ...g.contract.developmentObligations, infrastructure: [] },
});

/** A tampered canonical contract digest. */
export const killTamperedCanonicalDigest = (g) => ({ ...g.contract, canonicalDigest: 'e'.repeat(64) });

/* ------------------------------------------------------------------ */
/* Parser RED seeds (structural, closed-vocabulary)                     */
/* ------------------------------------------------------------------ */

/** An unknown/flat-file field in an entry (a flat file list is not a realization). */
export const seedFlatFileList = (g) => mapInteractive(g.draft, (entry) => ({ ...entry, files: ['src/server.js', 'public/app.js'] }));

/** An AC decomposition presented instead of the realization section. */
export const seedAcDecompositionSubstitute = (g) => ({ ...g.draft, criteria: [{ criterionId: 'ac:elite-1', moduleRef: 'src/server.js' }] });

/** An open surface-kind vocabulary value. */
export const seedOpenSurfaceKind = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.map((surface) => (surface.surfaceId === 'arch:elite-hud' ? { ...surface, surfaceKind: 'database' } : surface)),
});

/** An open evidence-kind vocabulary value. */
export const seedOpenEvidenceKind = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  evidenceBinding: { ...entry.evidenceBinding, evidenceKind: 'vibes' },
}));

/** An off-pattern surface id. */
export const seedOffPatternId = (g) => ({
  ...g.draft,
  surfaces: g.draft.surfaces.map((surface) => (surface.surfaceId === 'arch:elite-hud' ? { ...surface, surfaceId: 'Elite HUD!!' } : surface)),
});

/** A missing required field. */
export const seedMissingField = (g) => mapInteractive(g.draft, (entry) => {
  const broken = { ...entry };
  delete broken.terminalResult;
  return broken;
});

/** A self-edge in the runtime graph. */
export const seedSelfEdge = (g) => mapInteractive(g.draft, (entry) => ({
  ...entry,
  runtimeEdges: [...entry.runtimeEdges, { fromSurfaceRef: 'arch:elite-domain', toSurfaceRef: 'arch:elite-domain' }],
}));

/** No implementation surfaces cited. */
export const seedNoImplementationSurfaces = (g) => mapInteractive(g.draft, (entry) => ({ ...entry, implementationSurfaceRefs: [] }));

/** A wrong schema version. */
export const seedWrongSchemaVersion = (g) => ({ ...g.draft, schemaVersion: 'formalization.srs-realization.v0' });

/** The draft carrying its own digest (the parser seals digests itself). */
export const seedSuppliedDigest = (g) => ({ ...g.draft, realizationDigest: '0'.repeat(64) });

/** A missing lineage block. */
export const seedMissingLineage = (g) => {
  const broken = { ...g.draft };
  delete broken.lineage;
  return broken;
};
