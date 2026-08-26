/**
 * cli-stats/src/stats.mjs - the CLI text-statistics product (plan EK-11 P03):
 * deterministic text analytics. Pure functions; the CLI entry reads a file
 * (or stdin) and prints one JSON verdict.
 */

/** Analyze one text into its deterministic statistics document. */
export function analyze(text) {
  const raw = text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
  /* wc -l semantics: a trailing newline terminates the last line, it does
     not open a new (empty) one. */
  const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const characters = [...text].length;
  const frequency = new Map();
  for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const top = [...frequency.entries()]
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : (a[0] < b[0] ? -1 : 1)))
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));
  return {
    kind: 'cli-stats.report.v1',
    lines: lines.length,
    words: words.length,
    characters,
    uniqueWords: frequency.size,
    averageWordLength: words.length === 0 ? 0 : Number((words.reduce((sum, word) => sum + word.length, 0) / words.length).toFixed(3)),
    topWords: top,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop());
if (isMain) {
  const target = process.argv[2];
  let text = '';
  if (target !== undefined) {
    text = (await import('node:fs')).readFileSync(target, 'utf8');
  } else {
    text = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
    });
  }
  process.stdout.write(`${JSON.stringify(analyze(text), null, 2)}\n`);
}
