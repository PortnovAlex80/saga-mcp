/**
 * Factory-managed repository paths (workshop fix, killed projects 9 and 6).
 *
 * The Factory itself writes material INTO the product repository: worker
 * desk/execution trackers under `docs/<stage>/projects/<epicId>/executions/...`
 * and the `.saga-bootstrap.md` bootstrap note (any directory). These files are
 * Factory-owned process material, not product source. When a worker commits
 * or declares them alongside its real work, the implementation-scope check's
 * exact-set equality against the authoritative Git diff broke even though the
 * worker's PRODUCT file list was coherent.
 *
 * This predicate names that surface ONCE so both sides of the comparison
 * (declared changedFiles and the authoritative diff) can exclude it
 * symmetrically. It is deliberately narrow: only the two Factory-owned
 * shapes, never a general "docs/" exemption.
 */

/**
 * True when the repository-relative path is Factory-managed process material:
 *
 *   - `.saga-bootstrap.md` in any directory; or
 *   - `docs/<...>/executions/...` — a `docs/` root, then at least one segment,
 *     then an `executions/` segment (the desk/execution tracker layout the
 *     Factory materializes per node execution).
 *
 * Both separators are tolerated; comparison is exact-string per segment.
 */
export function isFactoryManagedRepositoryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  if (fileName === '.saga-bootstrap.md') return true;
  if (segments[0] !== 'docs') return false;
  // docs/ then at least one intermediate segment, then an executions/ segment.
  for (let index = 2; index < segments.length; index += 1) {
    if (segments[index] === 'executions') return true;
  }
  return false;
}

/**
 * Split a normalized path list into the product-relevant remainder and the
 * Factory-managed carve-out, preserving order and determinism.
 */
export function partitionFactoryManagedPaths(
  paths: readonly string[],
): { productPaths: string[]; factoryManagedPaths: string[] } {
  const productPaths: string[] = [];
  const factoryManagedPaths: string[] = [];
  for (const path of paths) {
    if (isFactoryManagedRepositoryPath(path)) {
      factoryManagedPaths.push(path);
    } else {
      productPaths.push(path);
    }
  }
  return { productPaths, factoryManagedPaths };
}
