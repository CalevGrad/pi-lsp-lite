/**
 * In-memory diagnostic log for the extension.
 *
 * Pi owns stdout, so the extension keeps its own lines here and the user reads
 * them with `/lsp-log`. Capacity is a hard bound because a chatty language
 * server writes its stderr through this buffer without pause.
 */

export type LogLevel = "error" | "warning" | "info";

export interface LogEntry {
  seq: number;
  time: Date;
  level: LogLevel;
  /** Server id, or `"<id>:<root>"` for a process, or "" for extension-wide lines. */
  scope: string;
  message: string;
}

export interface LogBufferOptions {
  /** Entries kept before the oldest is dropped. Default 200. */
  capacity?: number;
  /** Longest stored message; longer messages are cut with an ellipsis. Default 500. */
  maxMessageLength?: number;
}

export interface LogBuffer {
  error(scope: string, message: string): void;
  warning(scope: string, message: string): void;
  info(scope: string, message: string): void;
  /** Oldest entry first. The returned array is a copy. */
  entries(): LogEntry[];
  clear(): void;
}

const DEFAULT_CAPACITY = 200;
const DEFAULT_MAX_MESSAGE_LENGTH = 500;

/** Error as one readable string, stack included when there is one. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function formatTime(time: Date): string {
  return time.toTimeString().slice(0, 8);
}

/** One display line for one entry. */
export function formatLogEntry(entry: LogEntry): string {
  return `${formatTime(entry.time)} ${entry.level} ${entry.scope ? `[${entry.scope}] ` : ""}${entry.message}`;
}

export function createLogBuffer(options: LogBufferOptions = {}): LogBuffer {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const maxMessageLength = Math.max(1, options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH);
  const buffered: LogEntry[] = [];
  let nextSeq = 1;

  function push(level: LogLevel, scope: string, message: string): void {
    const text = message.length > maxMessageLength ? `${message.slice(0, maxMessageLength - 1)}…` : message;
    buffered.push({ seq: nextSeq++, time: new Date(), level, scope, message: text });
    if (buffered.length > capacity) buffered.splice(0, buffered.length - capacity);
  }

  return {
    error: (scope, message) => push("error", scope, message),
    warning: (scope, message) => push("warning", scope, message),
    info: (scope, message) => push("info", scope, message),
    entries: () => [...buffered],
    clear: () => {
      buffered.length = 0;
    },
  };
}

/** Log shared by the extension and everything under `src/`. */
export const log: LogBuffer = createLogBuffer();
