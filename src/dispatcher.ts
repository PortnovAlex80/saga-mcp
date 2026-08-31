import { readFileSync, writeFileSync, statSync } from 'node:fs';

// Признак жизни диспетчера — того, кто нанимает воркеров (мост).
//
// Зачем: таймаут `schedule-to-start` защищает от «эту работу никто никогда не
// возьмёт», а не от «сейчас все воркеры заняты». Ожидание в очереди за нашим
// же лимитом параллельности — это ЛЕГИТИМНАЯ ПАУЗА, и по правилу, которое мы
// взяли у n8n, пауза никогда не превращается в крах. Пока диспетчер жив,
// очередь просто ждёт; если он мёртв — работу действительно никто не возьмёт,
// и снимать её честно.
//
// Живёт рядом с базой, как и лимиты: это состояние ХОСТА, а не продукта,
// его нечего реплеить и незачем хранить в журнале.

function dispatcherPath(dbPath = process.env.DB_PATH ?? ''): string {
  if (!dbPath) throw new Error('DB_PATH is required to locate the dispatcher heartbeat');
  return `${dbPath}.dispatcher`;
}

/** Диспетчер сообщает, что он на месте и разбирает очередь. */
export function markDispatcherAlive(dbPath?: string): void {
  try {
    writeFileSync(dispatcherPath(dbPath), String(Date.now()), 'utf8');
  } catch {
    // Отметка о жизни не имеет права ронять смену.
  }
}

/** true — диспетчер отмечался недавно, значит очередь именно ждёт. */
export function dispatcherAlive(withinMs = 15_000, dbPath?: string): boolean {
  try {
    const file = dispatcherPath(dbPath);
    const stamp = Number(readFileSync(file, 'utf8')) || statSync(file).mtimeMs;
    return Date.now() - stamp < withinMs;
  } catch {
    return false;
  }
}
