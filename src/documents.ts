import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ДОКУМЕНТЫ ПРОДУКТА — спецификации, которые правит человек.
//
// До сих пор артефакт можно было править только ВНУТРИ открытого прогона:
// правка была сдачей материала на стол. Это верно для работы, которая идёт,
// и бесполезно для продукта, который уже выпущен, — а именно там человек и
// хочет что-то поменять.
//
// Поэтому у документа своя жизнь, и хранилище у неё уже есть: репозиторий
// продукта. Git — это и есть история документа: версия, автор, дата, разница
// с предыдущей. Второго авторитета мы не заводим — журнал остаётся властью
// над РАБОТОЙ завода, git над СОДЕРЖИМЫМ продукта. Это разные предметы.

export interface ProductDocument {
  path: string;
  content: string;
  /** Коммит, которым документ был записан в последний раз. */
  commit?: string;
  /** Кто его писал: цех завода или человек. */
  author?: string;
  updated_at?: string;
  exists: boolean;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function safeGit(repo: string, args: string[]): string | undefined {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
}

/** Путь внутри репозитория — и никуда больше. */
function resolveInRepo(repo: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error(`DOCUMENT_PATH_INVALID: '${filePath}'`);
  }
  return path.join(repo, normalized);
}

export function readDocument(repo: string, filePath: string): ProductDocument {
  const full = resolveInRepo(repo, filePath);
  if (!existsSync(full)) return { path: filePath, content: '', exists: false };
  const log = safeGit(repo, ['log', '-1', '--format=%H%x00%an%x00%aI', '--', filePath]);
  const [commit, author, updated] = (log ?? '').split('\0');
  return {
    path: filePath,
    content: readFileSync(full, 'utf8'),
    commit: commit || undefined,
    author: author || undefined,
    updated_at: updated || undefined,
    exists: true,
  };
}

export interface DocumentSave {
  path: string;
  commit: string;
  /** Разница с предыдущей версией — это и есть ЗАКАЗ на изменение. */
  patch: string;
  changed: boolean;
}

/** Сохранить правку человека новой версией документа.
 *
 *  Правка НЕ проходит приёмку, и это намеренно: спецификация — то, чего хочет
 *  человек, а приёмка судит работу завода. Судить желание заказчика заводу
 *  нечем и незачем. Провенанс при этом честный: коммит подписан `operator:`,
 *  и по журналу git видно, где кончился завод и начался человек. */
export function saveDocument(
  repo: string,
  filePath: string,
  content: string,
  note?: string
): DocumentSave {
  const full = resolveInRepo(repo, filePath);
  const before = existsSync(full) ? readFileSync(full, 'utf8') : '';
  if (before === content) {
    return { path: filePath, commit: safeGit(repo, ['rev-parse', 'HEAD']) ?? '', patch: '', changed: false };
  }
  const dirty = safeGit(repo, ['status', '--porcelain']);
  if (dirty && dirty.length > 0) {
    throw new Error('DOCUMENT_REPO_DIRTY: в репозитории продукта есть несохранённые изменения');
  }
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  git(repo, ['add', '--', filePath]);
  git(repo, [
    'commit',
    '-m', `operator: ${filePath}${note ? ` — ${note}` : ''}`,
    '-m', 'Author-Role: operator',
  ]);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  return { path: filePath, commit, patch: documentPatch(repo, filePath, commit), changed: true };
}

/** Что именно изменилось этим коммитом. Заводу нужен ЗАКАЗ, а не новая
 *  редакция целиком: «сделай, чтобы стало вот так» превращает любое уточнение
 *  в переписывание продукта, а «вот что изменилось» — в правку. */
export function documentPatch(repo: string, filePath: string, commit: string): string {
  return safeGit(repo, ['show', '--format=', '--unified=3', commit, '--', filePath]) ?? '';
}

/** Все документы-спецификации продукта: то, что человеку можно править. */
export function listDocuments(repo: string, globs: readonly string[] = ['*.md']): ProductDocument[] {
  const tracked = safeGit(repo, ['ls-files', ...globs, ...globs.map((g) => `**/${g}`)]);
  const seen = new Set<string>();
  const out: ProductDocument[] = [];
  for (const line of (tracked ?? '').split('\n')) {
    const file = line.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(readDocument(repo, file));
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Полный набор файлов продукта — то, чего завод до сих пор не знал: он умел
 *  ПИСАТЬ файлы, но не видел набора, поэтому файлы прошлых прогонов оставались
 *  сиротами (замерено: пять мёртвых файлов от предыдущих выпусков Элиты). */
export function productFiles(repo: string, exclude: readonly string[] = []): string[] {
  const tracked = safeGit(repo, ['ls-files']) ?? '';
  return tracked
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.length > 0 && !exclude.some((prefix) => file.startsWith(prefix)));
}
