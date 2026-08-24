/**
 * Documentation workshop — concrete infrastructure adapters.
 *
 * Product reader: resolves exact sealed product payloads. Documentation
 * author products are typed managed submissions (`managed-node-submission:<id>`),
 * so the reader pins the row by id + schema + content hash (ADR-053: digest is
 * the authority, never chronology).
 *
 * Repository observation: reads the project repository at the EXACT integrated
 * commit via git plumbing — never the mutable working copy.
 */

import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  DocumentationProductReader,
  DocumentationProductRef,
  DocumentationRepositoryObservationPort,
} from '../domain/documentation-kernel-ports.js';
import { DOCUMENTATION_DOCUMENT_SCHEMA } from '../domain/documentation-schemas.js';

export function createDocumentationProductReader(
  db: Database.Database,
): DocumentationProductReader {
  return {
    readProductPayload(productRef: DocumentationProductRef): unknown {
      if (productRef.ref.startsWith('managed-node-submission:')) {
        const id = Number(productRef.ref.slice('managed-node-submission:'.length));
        if (!Number.isSafeInteger(id) || id < 1) {
          throw new Error(`DOCUMENTATION_PRODUCT_REF_INVALID: ${productRef.ref}`);
        }
        const row = db.prepare(
          `SELECT payload_snapshot,schema_version,content_hash
             FROM factory_managed_node_submissions
            WHERE id=? AND schema_version=? AND content_hash=?`,
        ).get(id, productRef.schemaId, productRef.digest) as {
          payload_snapshot: string;
        } | undefined;
        if (!row) {
          throw new Error(`DOCUMENTATION_PRODUCT_NOT_FOUND: ${productRef.ref}`);
        }
        const payload = JSON.parse(row.payload_snapshot) as unknown;
        if (sha256Hex(payload) !== productRef.digest) {
          throw new Error(`DOCUMENTATION_PRODUCT_DIGEST_MISMATCH: ${productRef.ref}`);
        }
        return payload;
      }
      throw new Error(
        `DOCUMENTATION_PRODUCT_READER_UNSUPPORTED_REF: ${productRef.ref} `
        + `(expected ${DOCUMENTATION_DOCUMENT_SCHEMA} managed submission)`,
      );
    },
  };
}

export function createGitDocumentationRepositoryObservation(
  db: Database.Database,
): DocumentationRepositoryObservationPort {
  const localPath = (projectRepositoryId: number): string | null => {
    const row = db.prepare(
      `SELECT local_path FROM project_repositories
        WHERE id=? AND status='active'`,
    ).get(projectRepositoryId) as { local_path: string | null } | undefined;
    return row?.local_path ?? null;
  };
  const git = (repoPath: string, ...args: string[]): string => {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `DOCUMENTATION_REPOSITORY_OBSERVATION_FAILED: git ${args.join(' ')}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return {
    listTree(projectRepositoryId, commitSha) {
      const repoPath = localPath(projectRepositoryId);
      if (!repoPath) return [];
      return git(repoPath, 'ls-tree', '-r', '--name-only', commitSha)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    },
    readFileAt(projectRepositoryId, commitSha, filePath, maxBytes) {
      const repoPath = localPath(projectRepositoryId);
      if (!repoPath) return null;
      try {
        const bytes = Buffer.from(
          git(repoPath, 'show', `${commitSha}:${filePath}`),
          'utf8',
        );
        return {
          bytes: bytes.subarray(0, maxBytes).toString('utf8'),
          truncated: bytes.byteLength > maxBytes,
        };
      } catch {
        return null;
      }
    },
  };
}
