export type RepositoryScope =
  | Readonly<{ kind: 'exact-file'; path: string }>
  | Readonly<{ kind: 'directory-prefix'; path: string }>;

function normalizeSegments(value: string, code: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      || normalized.includes('\0')) {
    throw new Error(`${code}: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${code}: ${value}`);
  }
  if (segments[0]?.toLocaleLowerCase('en-US') === '.git') {
    throw new Error(`REPOSITORY_GIT_INTERNAL_PATH_DENIED: ${value}`);
  }
  return normalized;
}

export function parseRepositoryFilePath(value: string): string {
  if (value.endsWith('/') || value.endsWith('\\')) {
    throw new Error(`REPOSITORY_FILE_PATH_INVALID: ${value}`);
  }
  return normalizeSegments(value, 'REPOSITORY_FILE_PATH_INVALID');
}

export function parseRepositoryScope(value: string): RepositoryScope {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`REPOSITORY_SCOPE_INVALID: ${String(value)}`);
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const directory = normalized.endsWith('/');
  const path = normalizeSegments(directory ? normalized.slice(0, -1) : normalized,
    'REPOSITORY_SCOPE_INVALID');
  return directory ? { kind: 'directory-prefix', path } : { kind: 'exact-file', path };
}

export function repositoryScopeContainsPath(scope: RepositoryScope, candidate: string): boolean {
  const path = parseRepositoryFilePath(candidate);
  return scope.kind === 'exact-file' ? path === scope.path : path.startsWith(`${scope.path}/`);
}

export function repositoryScopesOverlapParsed(left: RepositoryScope, right: RepositoryScope): boolean {
  if (left.kind === 'exact-file' && right.kind === 'exact-file') return left.path === right.path;
  if (left.kind === 'directory-prefix' && right.kind === 'directory-prefix') {
    return left.path === right.path
      || left.path.startsWith(`${right.path}/`)
      || right.path.startsWith(`${left.path}/`);
  }
  const file = left.kind === 'exact-file' ? left.path : right.path;
  const directory = left.kind === 'directory-prefix' ? left.path : right.path;
  return file.startsWith(`${directory}/`);
}

export function repositoryScopesOverlap(left: string, right: string): boolean {
  return repositoryScopesOverlapParsed(parseRepositoryScope(left), parseRepositoryScope(right));
}

export function repositoryScopeCovers(scope: string, required: string): boolean {
  const authority = parseRepositoryScope(scope);
  const requirement = parseRepositoryScope(required);
  if (requirement.kind === 'exact-file') return repositoryScopeContainsPath(authority, requirement.path);
  return authority.kind === 'directory-prefix'
    && (requirement.path === authority.path || requirement.path.startsWith(`${authority.path}/`));
}
