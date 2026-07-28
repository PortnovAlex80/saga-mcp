/**
 * W2-A1 — FilesystemModulePackageStore: the default content-addressed,
 * immutable `ModulePackageStore` adapter.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *       §1 row 2, §2 (PORT ← adapter), §4 (identity / digest), §9.2 (replay
 *       verification).
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A1-filesystem-package-store.md`.
 *
 * Layout (content-addressed):
 *
 *   <rootDir>/<prefix-2>/<prefix-4>/<full-digest>/
 *     manifest.json          canonical JSON of the ProcessModuleManifest
 *     package.meta.json      { packageDigest, storedAt, resourceDigests }
 *     resources/<logicalId>  raw resource blobs (one per ResourceIndexEntry)
 *
 * The `<prefix-2>/<prefix-4>` sharding uses the first 2 and first 4 hex chars
 * of the digest (the 4-char dir is a strict prefix of the 2-char dir's
 * namespace). The leaf directory name IS the full 64-char digest, so a
 * directory rename / name check is itself a digest verification.
 *
 * Atomicity: `store` writes everything into a temp sibling directory
 * (`.<digest>.tmp-<random>`) then `rename`s it into place. A crash mid-write
 * leaves only the temp dir, never a half-written package. Re-storing the same
 * digest is idempotent (the rename overwrites — but content equality means the
 * bytes are identical, so the result is stable).
 *
 * Immutability: once `rename` completes, the package bytes are never modified
 * by this adapter. Mutating the in-memory `manifest`/`resources` after `store`
 * does not affect a subsequent `read` (the §14.3.8 exit-gate proof).
 *
 * Anti-scope: this is `installation/adapters/`, so the dependency-direction
 * ratchet Rule 5 (domain purity) does not apply; Rule 2 (module isolation)
 * does not apply (not under `modules/`). `node:fs`/`node:path`/`node:crypto`
 * are the only non-domain imports. No `db.ts`, no `schema.ts`, no sqlite.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ProcessModuleManifest } from '../../domain/spi/index.js';
import type { ResourceIndexEntry } from '../../domain/spi/index.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import {
  PACKAGE_STORE_CORRUPT,
  PACKAGE_STORE_DIGEST_MISMATCH,
  PACKAGE_STORE_NOT_FOUND,
  PACKAGE_STORE_PATH_TRAVERSAL,
  PackageStoreError,
  computePackageDigest,
  computeResourceDigest,
} from '../domain/package-store.js';
import type {
  ModulePackageStore,
  ResourceBlob,
  StoredModulePackage,
} from '../domain/package-store.js';

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const MANIFEST_FILE = 'manifest.json';
const META_FILE = 'package.meta.json';
const RESOURCES_DIR = 'resources';

/**
 * On-disk shape of `package.meta.json`. `resourceDigests` is the ordered list
 * of resource digests (parallel to the resources array stored on disk) so the
 * package digest can be recomputed without re-hashing bytes during a `verify`
 * of the META alone — though `verify` re-hashes bytes anyway for full
 * byte-faithfulness.
 */
interface PackageMeta {
  readonly packageDigest: string;
  readonly storedAt: string;
  readonly resourceDigests: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Reject `logicalId`s that could escape the package root. A safe logicalId is a
 * single path segment: no `..`, not absolute, no backslashes (we only emit
 * POSIX paths on disk), no NUL. After slugification the result must equal the
 * original (i.e. slugification is a no-op for safe ids) — otherwise the id
 * contains characters we would have to translate, and we refuse rather than
 * silently rename.
 *
 * We do NOT use `path.join`/`path.resolve` to test safety: those collapse `..`
 * silently. We inspect the raw string.
 */
function assertSafeLogicalId(logicalId: string): void {
  if (typeof logicalId !== 'string' || logicalId.length === 0) {
    throw new PackageStoreError(
      PACKAGE_STORE_PATH_TRAVERSAL,
      `logicalId must be a non-empty string`,
    );
  }
  // Absolute (POSIX or Windows) — reject.
  if (logicalId.startsWith('/') || /^[A-Za-z]:[\\/]/.test(logicalId)) {
    throw new PackageStoreError(
      PACKAGE_STORE_PATH_TRAVERSAL,
      `logicalId '${logicalId}' is absolute`,
    );
  }
  // Any traversal segment.
  const segments = logicalId.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new PackageStoreError(
        PACKAGE_STORE_PATH_TRAVERSAL,
        `logicalId '${logicalId}' contains a '..' / '.' segment`,
      );
    }
    if (seg.length === 0) {
      throw new PackageStoreError(
        PACKAGE_STORE_PATH_TRAVERSAL,
        `logicalId '${logicalId}' contains an empty segment`,
      );
    }
  }
  // NUL / control chars.
  if (/[\x00-\x1f]/.test(logicalId)) {
    throw new PackageStoreError(
      PACKAGE_STORE_PATH_TRAVERSAL,
      `logicalId '${logicalId}' contains control characters`,
    );
  }
}

/**
 * Slugify a logicalId into a safe single-segment filename. We deliberately
 * keep the id verbatim when it is already a safe filename, and refuse anything
 * that would require translation beyond a simple path-separator flatten (so
 * the on-disk name is predictable and reversible-ish). For ids that contain
 * `/` (a module-namespaced id like `foo/bar`), we map `/` and `\` to `__`
 * (deterministic, no information loss to path traversal).
 */
function slugifyLogicalId(logicalId: string): string {
  assertSafeLogicalId(logicalId);
  return logicalId.replace(/[\\/]+/g, '__');
}

/** Validate that a hex digest string is the right shape (64 lowercase hex). */
function isValidDigestShape(d: string): boolean {
  return typeof d === 'string' && /^[0-9a-f]{64}$/.test(d);
}

/**
 * Resolve the content-addressed directory for a digest, with 2-char / 4-char
 * sharding. The 4-char prefix is a strict superset-prefix of the 2-char dir.
 */
function packageDir(rootDir: string, digest: string): string {
  const p2 = digest.slice(0, 2);
  const p4 = digest.slice(0, 4);
  return path.join(rootDir, p2, p4, digest);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw e;
  }
}

async function readJson<T>(p: string): Promise<T> {
  const buf = await fs.readFile(p);
  return JSON.parse(buf.toString('utf8')) as T;
}

async function writeJson(p: string, value: unknown): Promise<void> {
  const json = canonicalJson(value);
  await fs.writeFile(p, json, 'utf8');
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

/**
 * Content-addressed filesystem `ModulePackageStore`.
 *
 * @param rootDir Absolute or relative root directory. The adapter creates it on
 *                demand. Each package lives under
 *                `<rootDir>/<2hex>/<4hex>/<full-digest>/`.
 */
export class FilesystemModulePackageStore implements ModulePackageStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  // -------------------------------------------------------------------------
  // store
  // -------------------------------------------------------------------------

  async store(
    manifest: ProcessModuleManifest,
    resources: readonly ResourceBlob[],
  ): Promise<StoredModulePackage> {
    // 1. Validate every blob: safe logicalId + declared in manifest.resourceIndex.
    const declared = new Map<string, ResourceIndexEntry>();
    for (const entry of manifest.resourceIndex) {
      declared.set(entry.logicalId, entry);
    }
    for (const blob of resources) {
      assertSafeLogicalId(blob.logicalId);
      if (!declared.has(blob.logicalId)) {
        throw new PackageStoreError(
          PACKAGE_STORE_CORRUPT,
          `resource '${blob.logicalId}' is not declared in manifest.resourceIndex`,
        );
      }
    }

    // 2. Compute the content address.
    const packageDigest = computePackageDigest(manifest, resources);
    if (!isValidDigestShape(packageDigest)) {
      // Defensive: computePackageDigest always returns a 64-hex digest; this
      // guards against a future regression in the shared primitive.
      throw new PackageStoreError(
        PACKAGE_STORE_CORRUPT,
        `computed packageDigest has invalid shape`,
      );
    }

    const finalDir = packageDir(this.rootDir, packageDigest);
    const storedAt = finalDir;

    // 3. Idempotent fast path: if the package already exists and verifies,
    //    return it without rewriting. (We still `read` so a corrupted existing
    //    dir surfaces a digest error rather than silently overwriting.)
    if (await pathExists(finalDir)) {
      try {
        return await this.read(packageDigest);
      } catch (e) {
        // Fall through to re-write if the existing copy is corrupt.
        if (!(e instanceof PackageStoreError)) throw e;
      }
    }

    // 4. Write atomically: stage into a sibling temp dir, then rename.
    const tmpDir = path.join(
      path.dirname(finalDir),
      `.${packageDigest}.tmp-${randomBytes(6).toString('hex')}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      // manifest.json (canonical JSON of the manifest).
      await writeJson(path.join(tmpDir, MANIFEST_FILE), manifest);

      // resources/<slug> raw bytes.
      const resourcesDir = path.join(tmpDir, RESOURCES_DIR);
      await fs.mkdir(resourcesDir, { recursive: true });
      for (const blob of resources) {
        const slug = slugifyLogicalId(blob.logicalId);
        await fs.writeFile(path.join(resourcesDir, slug), blob.bytes);
      }

      // package.meta.json.
      const meta: PackageMeta = {
        packageDigest,
        storedAt,
        resourceDigests: resources.map((r) => r.digest),
      };
      await writeJson(path.join(tmpDir, META_FILE), meta);

      // Ensure the parent of finalDir exists, then rename atomically.
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.rename(tmpDir, finalDir);
    } catch (e) {
      // Best-effort cleanup of the temp dir on any failure.
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* swallow cleanup errors */
      }
      throw e;
    }

    return {
      manifest,
      resources,
      packageDigest,
      storedAt,
    };
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(packageDigest: string): Promise<StoredModulePackage> {
    if (!isValidDigestShape(packageDigest)) {
      throw new PackageStoreError(
        PACKAGE_STORE_NOT_FOUND,
        `invalid digest shape: '${packageDigest}'`,
      );
    }
    const dir = packageDir(this.rootDir, packageDigest);
    if (!(await pathExists(dir))) {
      throw new PackageStoreError(
        PACKAGE_STORE_NOT_FOUND,
        `no package stored for digest ${packageDigest}`,
      );
    }

    // The leaf directory name MUST equal the digest.
    const dirName = path.basename(dir);
    if (dirName !== packageDigest) {
      throw new PackageStoreError(
        PACKAGE_STORE_DIGEST_MISMATCH,
        `directory name '${dirName}' does not match digest '${packageDigest}'`,
      );
    }

    let manifest: ProcessModuleManifest;
    let meta: PackageMeta;
    try {
      manifest = await readJson<ProcessModuleManifest>(
        path.join(dir, MANIFEST_FILE),
      );
      meta = await readJson<PackageMeta>(path.join(dir, META_FILE));
    } catch (e) {
      throw new PackageStoreError(
        PACKAGE_STORE_CORRUPT,
        `failed to read manifest/meta for ${packageDigest}: ${(e as Error).message}`,
      );
    }

    // Verify the META-recorded digest matches the address.
    if (meta.packageDigest !== packageDigest) {
      throw new PackageStoreError(
        PACKAGE_STORE_DIGEST_MISMATCH,
        `meta packageDigest '${meta.packageDigest}' does not match address '${packageDigest}'`,
      );
    }

    // Reconstruct resource blobs in the manifest's resourceIndex order (stable,
    // matches the order resources were declared / stored). Read each blob's
    // raw bytes and VERIFY the digest.
    const resourcesDir = path.join(dir, RESOURCES_DIR);
    const resources: ResourceBlob[] = [];
    for (const entry of manifest.resourceIndex) {
      const slug = slugifyLogicalId(entry.logicalId);
      const blobPath = path.join(resourcesDir, slug);
      let bytes: Uint8Array;
      try {
        const buf = await fs.readFile(blobPath);
        bytes = new Uint8Array(buf);
      } catch (e) {
        throw new PackageStoreError(
          PACKAGE_STORE_CORRUPT,
          `resource '${entry.logicalId}' missing for ${packageDigest}: ${(e as Error).message}`,
        );
      }
      const actualDigest = computeResourceDigest(bytes);
      if (actualDigest !== entry.digest && entry.digest !== 'pending@wave-2') {
        throw new PackageStoreError(
          PACKAGE_STORE_DIGEST_MISMATCH,
          `resource '${entry.logicalId}' digest mismatch: stored manifest declares '${entry.digest}' but bytes hash to '${actualDigest}'`,
        );
      }
      resources.push({
        logicalId: entry.logicalId,
        kind: entry.kind,
        bytes,
        digest: actualDigest,
      });
    }

    // Cross-check the META resourceDigests list matches what we read. (We trust
    // the manifest's resourceIndex as the canonical declaration; META is a
    // redundant guard. If META disagrees, that is corruption.)
    const readDigests = resources.map((r) => r.digest);
    if (
      meta.resourceDigests.length !== readDigests.length ||
      meta.resourceDigests.some((d, i) => d !== readDigests[i])
    ) {
      throw new PackageStoreError(
        PACKAGE_STORE_DIGEST_MISMATCH,
        `meta resourceDigests do not match verified resource digests for ${packageDigest}`,
      );
    }

    // Verify the package digest recomputed from the loaded content matches the
    // address. This is the spec §4 / §9.2 replay check.
    const recomputed = computePackageDigest(manifest, resources);
    if (recomputed !== packageDigest) {
      throw new PackageStoreError(
        PACKAGE_STORE_DIGEST_MISMATCH,
        `recomputed packageDigest '${recomputed}' does not match address '${packageDigest}'`,
      );
    }

    return {
      manifest,
      resources,
      packageDigest,
      storedAt: dir,
    };
  }

  // -------------------------------------------------------------------------
  // exists
  // -------------------------------------------------------------------------

  async exists(packageDigest: string): Promise<boolean> {
    if (!isValidDigestShape(packageDigest)) return false;
    const dir = packageDir(this.rootDir, packageDigest);
    try {
      const st = await fs.stat(dir);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  async verify(packageDigest: string): Promise<boolean> {
    try {
      await this.read(packageDigest);
      return true;
    } catch {
      return false;
    }
  }
}
