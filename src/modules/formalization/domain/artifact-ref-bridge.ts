/**
 * ArtifactRefBridge — convert artifacts to ProductRef for the universal desk
 * (Conveyor v4 step 3.A.1).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-11 (Изделие) +
 * Conveyor Mental Model v4 §«One machine, one material, one desk».
 *
 * # Why this bridge exists
 *
 * Formalization's product IS an artifact (PRD, SRS, UC, AC, FR, NFR). v4
 * says every workshop places text on one universal desk. But artifacts live
 * in their own `artifacts` table (requirements-domain) with their own status
 * machine (draft→accepted). Duplicating the artifact BODY into
 * `workplace_products` would create two sources of truth for the same content.
 *
 * The bridge solves this: the workplace product stores a REFERENCE to the
 * artifact, not the artifact body itself. The ProductRef's:
 *   - `schemaId` = `'saga3.artifact-ref.v1'`
 *   - `ref` = `'artifact:<id>#<contentHash>'`
 *   - `digest` = the artifact's `content_hash`
 *
 * The formalization kernel's product contracts declare this schema; the
 * product repository accepts it; the gate reads it. When the gate needs the
 * BODY of the artifact (to validate content), it resolves the ref → reads the
 * `artifacts` row. The body is never copied into the product store.
 *
 * # Hash integrity (REG-11-AC-02)
 *
 * `workplace_products.contentHash` MUST equal `artifacts.content_hash` at all
 * times. A drift between them is a blocking error (REG-11-AC-02: "hash is
 * checked at the trust boundary"). The bridge enforces this on construction:
 * it reads the artifact's current `content_hash` and embeds it in the ref.
 */

import type { ProductRef } from '../../../process-modules/domain/spi/index.js';

/** The schema id for an artifact-reference product on the universal desk. */
export const ARTIFACT_REF_SCHEMA = 'saga3.artifact-ref.v1' as const;

/**
 * Build a ProductRef that references an artifact BY ID + content-hash, without
 * copying the artifact body.
 *
 * The caller passes the artifact's current `content_hash` (read from the
 * `artifacts` row). The bridge embeds it in both `ref` (for human inspection)
 * and `digest` (for content-addressed lookup). The product store uses the
 * digest to verify integrity at read time.
 */
export function buildArtifactProductRef(input: {
  artifactId: number;
  contentHash: string;
}): ProductRef {
  if (!Number.isInteger(input.artifactId) || input.artifactId <= 0) {
    throw new Error(
      `buildArtifactProductRef: artifactId must be a positive integer, got ${input.artifactId}`,
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(input.contentHash)) {
    throw new Error(
      `buildArtifactProductRef: contentHash must be a 64-char hex SHA-256`,
    );
  }
  return {
    schemaId: ARTIFACT_REF_SCHEMA,
    ref: `artifact:${input.artifactId}#${input.contentHash}`,
    digest: input.contentHash,
  };
}

/**
 * Parse an artifact-ref ProductRef back into its components.
 *
 * Used by the formalization kernel / gate when it needs to resolve the ref
 * to the artifact row (read the body for content validation).
 */
export function parseArtifactProductRef(ref: ProductRef): {
  artifactId: number;
  contentHash: string;
} {
  if (ref.schemaId !== ARTIFACT_REF_SCHEMA) {
    throw new Error(
      `parseArtifactProductRef: expected schema '${ARTIFACT_REF_SCHEMA}', got '${ref.schemaId}'`,
    );
  }
  // Format: 'artifact:<id>#<hash>'
  const m = /^artifact:(\d+)#([a-f0-9]{64})$/i.exec(ref.ref);
  if (!m) {
    throw new Error(
      `parseArtifactProductRef: ref '${ref.ref}' does not match artifact:<id>#<hash>`,
    );
  }
  return {
    artifactId: Number(m[1]),
    contentHash: m[2]!.toLowerCase(),
  };
}

/**
 * Verify that an artifact's current content_hash matches the ProductRef's
 * digest. REG-11-AC-02: hash is checked at the trust boundary.
 *
 * Returns true when they match; false on drift (the caller treats drift as a
 * blocking error — the artifact was mutated after the product was sealed).
 */
export function artifactHashMatchesRef(
  artifactContentHash: string | null,
  ref: ProductRef,
): boolean {
  if (!artifactContentHash) return false;
  return artifactContentHash.toLowerCase() === ref.digest.toLowerCase();
}
