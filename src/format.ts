import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";
import type { DiagnosticResult } from "./client.js";

const MAX_DIAGNOSTICS_PER_FILE = 50;

export function formatDiagnostics(filePath: string, result: DiagnosticResult, cwd?: string): string {
  const allRelevant = result.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );

  if (allRelevant.length === 0 && result.status === "ok" && result.otherFiles.length === 0) return "";

  if (result.status === "unavailable") {
    return `\n⚠ LSP diagnostics unavailable for ${filePath} (server missing or failed to start)`;
  }

  const truncated = allRelevant.length > MAX_DIAGNOSTICS_PER_FILE;
  const relevant = truncated ? allRelevant.slice(0, MAX_DIAGNOSTICS_PER_FILE) : allRelevant;

  const retryNote = result.status === "timeout" && result.retryAttempts > 0
    ? ` after ${result.retryAttempts} ${result.retryAttempts === 1 ? "retry" : "retries"}`
    : "";

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length > 0) {
    return `\n⚠ LSP diagnostics for ${filePath}: no issues${otherFilesFooter(result, cwd)}`;
  }

  const lines = relevant.map((d) => {
    const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? `[${d.source}] ` : "";
    return `  ${severity} ${line}:${col} ${source}${d.message}`;
  });

  let errorCount = 0;
  for (const d of allRelevant) {
    if (d.severity === DiagnosticSeverity.Error) errorCount++;
  }
  const warnCount = allRelevant.length - errorCount;

  const summary = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : "",
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "",
    result.status === "timeout" ? `timed out${retryNote}, may be incomplete` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const truncatedNote = truncated ? `\n  ... and ${allRelevant.length - MAX_DIAGNOSTICS_PER_FILE} more` : "";

  return `\n⚠ LSP diagnostics for ${filePath} (${summary}):\n${lines.join("\n")}${truncatedNote}${otherFilesFooter(result, cwd)}`;
}

function otherFilesFooter(result: DiagnosticResult, cwd?: string): string {
  if (result.otherFiles.length === 0) return "";
  const lines = result.otherFiles.map((f) => {
    let path: string;
    try {
      const abs = fileURLToPath(f.uri);
      path = cwd ? relative(cwd, abs) : abs;
    } catch {
      path = f.uri;
    }
    const counts = [
      f.errorCount > 0 ? `${f.errorCount} error${f.errorCount > 1 ? "s" : ""}` : "",
      f.warningCount > 0 ? `${f.warningCount} warning${f.warningCount > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    if (!f.firstDiagnostic) return `  ${path} (${counts})`;
    const d = f.firstDiagnostic;
    const sev = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const src = d.source ? `[${d.source}] ` : "";
    return `  ${path} (${counts}): ${sev} ${d.line + 1}:${d.col + 1} ${src}${d.message}`;
  });
  return `\n${lines.join("\n")}`;
}

// --- Local patch (pi-lsp-lite UI): компактный вывод -------------------------
// Без планки один edit добавлял в transcript до 50 строк на файл плюс блок
// «other files»; на коротком терминале строка ввода и футер уезжали за край.
// Формат: одна диагностика — одна строка, многострочные сообщения clangd
// сворачиваются в строку.

const MAX_TOOL_RESULT_LINES = 10;
const MAX_DIAGNOSTIC_CHARS = 200;
/** Резерв под строку заголовка и две служебные строки («... and N more», «+N elsewhere»). */
const DIAGNOSTIC_LINE_BUDGET = MAX_TOOL_RESULT_LINES - 3;

export type StatusLevel = "error" | "warning" | "dim";

function messageOf(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function displayPath(filePath: string, cwd?: string): string {
  if (!cwd || !isAbsolute(filePath)) return filePath;
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}

function relevantOf(result: DiagnosticResult): Diagnostic[] {
  return result.diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning)
    .sort(
      (a, b) =>
        (a.severity ?? 0) - (b.severity ?? 0) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
}

function countBySeverity(diagnostics: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === DiagnosticSeverity.Error) errors++;
    else if (d.severity === DiagnosticSeverity.Warning) warnings++;
  }
  return { errors, warnings };
}

function countOtherFiles(result: DiagnosticResult): number {
  return result.otherFiles.reduce((total, f) => total + f.errorCount + f.warningCount, 0);
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Блок для tool_result: заголовок с счётчиками и не больше
 * DIAGNOSTIC_LINE_BUDGET строк диагностик. Пустая строка — показывать нечего.
 */
export function formatDiagnosticsCompact(filePath: string, result: DiagnosticResult, cwd?: string): string {
  if (result.status === "unavailable") {
    return `\n⚠ LSP diagnostics unavailable for ${displayPath(filePath, cwd)} (server missing or failed to start)`;
  }

  const relevant = relevantOf(result);
  if (relevant.length === 0) {
    // Таймаут с пустым списком — это «неизвестно», а не «чисто».
    return result.status === "timeout"
      ? `\n⚠ LSP diagnostics for ${displayPath(filePath, cwd)} (timed out, no diagnostics — incomplete)`
      : "";
  }

  const rel = displayPath(filePath, cwd);
  const { errors, warnings } = countBySeverity(relevant);
  const summary = [
    errors > 0 ? plural(errors, "error") : "",
    warnings > 0 ? plural(warnings, "warning") : "",
    result.status === "timeout" ? "timed out, may be incomplete" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const shown = relevant.slice(0, DIAGNOSTIC_LINE_BUDGET);
  const lines = shown.map((d) => {
    const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const code = d.code === undefined ? "" : ` (${d.code})`;
    const source = d.source ? ` [${d.source}]` : "";
    const message = singleLine(messageOf(d));
    const clipped = message.length > MAX_DIAGNOSTIC_CHARS ? `${message.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…` : message;
    return `  ${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity}: ${clipped}${code}${source}`;
  });

  const omitted = relevant.length - shown.length;
  if (omitted > 0) lines.push(`  ... and ${omitted} more in ${rel}`);
  const elsewhere = countOtherFiles(result);
  if (elsewhere > 0) {
    lines.push(`  + ${plural(elsewhere, "diagnostic")} in ${plural(result.otherFiles.length, "other file")} — /lsp-diag`);
  }

  return `\n⚠ LSP diagnostics for ${rel} (${summary}):\n${lines.join("\n")}`;
}

/** Одна строка для футера (ctx.ui.setStatus). */
export function formatStatusLine(
  filePath: string,
  result: DiagnosticResult,
  cwd?: string,
): { text: string; level: StatusLevel } {
  const rel = displayPath(filePath, cwd);
  if (result.status === "unavailable") return { text: `LSP: no server for ${rel}`, level: "warning" };

  const { errors, warnings } = countBySeverity(relevantOf(result));
  if (errors === 0 && warnings === 0) {
    return result.status === "timeout"
      ? { text: `LSP: timeout ${rel}`, level: "warning" }
      : { text: `LSP: clean ${rel}`, level: "dim" };
  }

  const parts = [errors > 0 ? plural(errors, "error") : "", warnings > 0 ? plural(warnings, "warning") : ""]
    .filter(Boolean);
  const elsewhere = countOtherFiles(result);
  if (elsewhere > 0) parts.push(`+${elsewhere} elsewhere`);
  if (result.status === "timeout") parts.push("incomplete");

  return { text: `LSP: ${parts.join(", ")} — ${rel}`, level: errors > 0 ? "error" : "warning" };
}
