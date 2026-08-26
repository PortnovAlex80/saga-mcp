/**
 * cli-transform/src/transform.mjs - the CSV-to-JSON transformer CLI (plan
 * EK-11 P06): deterministic conversion with typed row errors. CLI usage:
 * node src/transform.mjs <input.csv> [output.json]; stdout carries the JSON
 * document when no output path is given.
 */

/** Parse one RFC-4180-ish CSV line (quoted fields, doubled quotes). */
export function parseLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { fields.push(field); field = ''; }
    else field += char;
  }
  fields.push(field);
  return fields;
}

/** Transform CSV text into the deterministic JSON document. */
export function csvToJson(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { kind: 'cli-transform.document.v1', columns: [], rows: [], errors: [] };
  const columns = parseLine(lines[0]).map((column, index) => (column.length > 0 ? column : `column_${index + 1}`));
  const rows = [];
  const errors = [];
  for (let index = 1; index < lines.length; index += 1) {
    const fields = parseLine(lines[index]);
    if (fields.length !== columns.length) {
      errors.push({ row: index + 1, error: 'field-count', expected: columns.length, actual: fields.length });
      continue;
    }
    rows.push(Object.fromEntries(columns.map((column, position) => [column, fields[position]])));
  }
  return { kind: 'cli-transform.document.v1', columns, rows, errors };
}

const isMain = process.argv[1] !== undefined
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);
if (isMain) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [input, output] = process.argv.slice(2);
  if (input === undefined) {
    process.stderr.write('usage: transform.mjs <input.csv> [output.json]\n');
    process.exit(2);
  }
  const document = csvToJson(readFileSync(input, 'utf8'));
  const body = `${JSON.stringify(document, null, 2)}\n`;
  if (output === undefined) process.stdout.write(body);
  else writeFileSync(output, body, 'utf8');
  process.exitCode = document.errors.length > 0 ? 1 : 0;
}
