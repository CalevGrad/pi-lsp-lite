/**
 * Журнал расширения.
 *
 * В интерактивном режиме pi сама рисует интерфейс и не перехватывает вывод
 * расширений: console.error() попадает на тот же экран, который pi перерисовывает
 * покадрово, сбивает построчный учёт renderer'а и портит нижнюю часть (строка
 * ввода, счётчик токенов, режим) до ближайшего resize. Поэтому расширение пишет
 * сюда, а в stderr — только когда PI_LSP_DEBUG=1.
 */

const MAX_LOG_LINES = 200;
const buffer: string[] = [];

function describe(part: unknown): string {
  if (typeof part === "string") return part;
  if (part instanceof Error) return part.stack ?? part.message;
  return String(part);
}

function debugToStderr(): boolean {
  const raw = process.env.PI_LSP_DEBUG;
  return raw === "1" || raw === "true";
}

/** Заменить текст в буфере; в stderr — только в отладочном режиме. */
export function logLine(...parts: unknown[]): void {
  const message = parts.map(describe).join(" ");
  for (const line of message.split("\n")) {
    buffer.push(line);
    if (buffer.length > MAX_LOG_LINES) buffer.shift();
  }
  if (debugToStderr()) process.stderr.write(`${message}\n`);
}

/** Последние строки журнала — для /lsp-log. */
export function recentLogLines(limit = 20): string[] {
  return buffer.slice(-limit);
}
