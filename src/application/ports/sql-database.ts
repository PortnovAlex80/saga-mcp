/**
 * Driver-neutral structural SQL handle for module application services.
 * Concrete SQLite ownership stays in composition/infrastructure; modules see
 * only the query capability injected into them.
 */
export interface SqlStatementPort {
  get(...parameters: any[]): any;
  all(...parameters: any[]): any[];
  run(...parameters: any[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqlDatabasePort {
  prepare(source: string): SqlStatementPort;
  transaction<T>(operation: () => T): {
    (): T;
    immediate(): T;
  };
  exec(source: string): unknown;
}
