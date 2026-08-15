import type Database from 'better-sqlite3';
import type { ProductRef } from '../../process-modules/domain/spi/production-envelope.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

export interface SealedProductMaterial {
  readonly productRef: ProductRef;
  readonly payload: unknown;
}

/**
 * Clean-break post-seal product store. Ingress adapters resolve their mutable
 * or execution-scoped row once, before seal; every later consumer reads this
 * immutable schema/content material and verifies the exact alias separately.
 */
export class SqliteSealedProductMaterialRepository {
  constructor(private readonly db: Database.Database) {}

  seal(input: SealedProductMaterial): void {
    const payloadSnapshot = canonicalJson(input.payload);
    const payloadHash = sha256Hex(input.payload);
    if (payloadHash !== input.productRef.digest) {
      throw new Error(
        `SEALED_PRODUCT_DIGEST_MISMATCH: ${input.productRef.schemaId}/${input.productRef.ref}`,
      );
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_sealed_product_materials
         (schema_id,content_digest,payload_snapshot,payload_hash)
       VALUES (?,?,?,?)`,
    ).run(input.productRef.schemaId, input.productRef.digest, payloadSnapshot, payloadHash);
    const material = this.db.prepare(
      `SELECT payload_snapshot,payload_hash
         FROM factory_sealed_product_materials
        WHERE schema_id=? AND content_digest=?`,
    ).get(input.productRef.schemaId, input.productRef.digest) as {
      payload_snapshot: string;
      payload_hash: string;
    } | undefined;
    if (!material
        || material.payload_snapshot !== payloadSnapshot
        || material.payload_hash !== payloadHash) {
      throw new Error(
        `SEALED_PRODUCT_REPLAY_MISMATCH: ${input.productRef.schemaId}/${input.productRef.digest}`,
      );
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_sealed_product_aliases
         (product_ref,schema_id,content_digest) VALUES (?,?,?)`,
    ).run(input.productRef.ref, input.productRef.schemaId, input.productRef.digest);
    const alias = this.db.prepare(
      `SELECT content_digest FROM factory_sealed_product_aliases
        WHERE product_ref=? AND schema_id=?`,
    ).get(input.productRef.ref, input.productRef.schemaId) as {
      content_digest: string;
    } | undefined;
    if (!alias || alias.content_digest !== input.productRef.digest) {
      throw new Error(
        `SEALED_PRODUCT_ALIAS_MISMATCH: ${input.productRef.schemaId}/${input.productRef.ref}`,
      );
    }
  }

  readExact(productRef: ProductRef): unknown {
    const row = this.db.prepare(
      `SELECT material.payload_snapshot,material.payload_hash
         FROM factory_sealed_product_aliases alias
         JOIN factory_sealed_product_materials material
           ON material.schema_id=alias.schema_id
          AND material.content_digest=alias.content_digest
        WHERE alias.product_ref=? AND alias.schema_id=? AND alias.content_digest=?`,
    ).get(productRef.ref, productRef.schemaId, productRef.digest) as {
      payload_snapshot: string;
      payload_hash: string;
    } | undefined;
    if (!row) {
      throw new Error(
        `SEALED_PRODUCT_NOT_FOUND: ${productRef.schemaId}/${productRef.ref}/${productRef.digest}`,
      );
    }
    const payload = JSON.parse(row.payload_snapshot) as unknown;
    if (row.payload_hash !== productRef.digest || sha256Hex(payload) !== productRef.digest) {
      throw new Error(
        `SEALED_PRODUCT_CORRUPT: ${productRef.schemaId}/${productRef.ref}`,
      );
    }
    return payload;
  }
}
