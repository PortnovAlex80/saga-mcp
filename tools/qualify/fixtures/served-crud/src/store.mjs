/**
 * served-crud/src/store.mjs - the file-backed item store (plan EK-11 P05
 * todo / P09 notes / P15 operator / P20 expense families): deterministic
 * CRUD over a JSON file with monotonic ids. Pure node:fs; no dependencies.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createStore(dataFile) {
  const dir = dirname(dataFile);
  const read = () => {
    if (!existsSync(dataFile)) return { kind: 'served-crud.store.v1', items: [], nextId: 1 };
    return JSON.parse(readFileSync(dataFile, 'utf8'));
  };
  /** Atomic write: temp file + rename (a crash never truncates the store). */
  const write = (store) => {
    mkdirSync(dir, { recursive: true });
    const temp = `${dataFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(temp, dataFile);
  };
  return {
    list: () => read().items,
    get: (id) => read().items.find((item) => item.id === id) ?? null,
    create: (fields) => {
      const store = read();
      const item = { id: store.nextId, ...fields };
      store.items.push(item);
      store.nextId += 1;
      write(store);
      return item;
    },
    update: (id, patch) => {
      const store = read();
      const item = store.items.find((entry) => entry.id === id);
      if (item === undefined) return null;
      Object.assign(item, patch, { id: item.id });
      write(store);
      return item;
    },
    remove: (id) => {
      const store = read();
      const before = store.items.length;
      store.items = store.items.filter((item) => item.id !== id);
      const removed = store.items.length < before;
      write(store);
      return removed;
    },
  };
}
