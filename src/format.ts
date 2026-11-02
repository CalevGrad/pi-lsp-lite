import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { diagnosticMessage, type DiagnosticResult } from "./client.js";

/** Report lines for the edited file itself; every diagnostic renders as exactly one line. */
const MAX_TARGET_LINES = 20;
/** Report lines for other files, one line per file. */
const MAX_OTHER_FILE_LINES = 10;
/** Longest diagnostic message after newlines are folded. */
const MAX_MESSAGE_LENGTH = 200;

function severityRank(d: Diagnostic): number {
  if (d.severity === DiagnosticSeverity.Error) return 0;
  if (d.severity === DiagnosticSeverity.Warning) return 1;
  return 2;
}

/**
 * Errors first, then position. Without this a clang-tidy cascade sorts ahead of
 * the one compiler error, because the truncation below keeps the leading lines.
 */
function bySeverityThenPosition(a: Diagnostic, b: Diagnostic): number {
  const rank = severityRank(a) - severityRank(b);
  if (rank !== 0) return rank;
  const line = a.range.start.line - b.range.start.line;
  if (line !== 0) return line;
  return a.range.start.character - b.range.start.character;
}

/** clangd reports template errors over several lines; the report budget counts lines. */
function oneLine(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_LENGTH ? `${flat.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : flat;
}

function displayPath(uri: string, cwd?: string): string {
  try {
    const abs = fileURLToPath(uri);
    return cwd ? relative(cwd, abs) : abs;
  } catch {
    return uri;
  }
}

export function formatDiagnostics(filePath: string, result: DiagnosticResult, cwd?: string): string {
  // An unavailable server is the human's problem: a missing binary or a failed initialize. The
  // footer shows it in red and the agent's tool result stays untouched. Don't add a notice back
  // here — the agent can neither install a binary nor revive a crashed server, and it would
  // repeat on every edit of that language. The accepted cost is that an unchecked file now reads
  // to the agent as an unremarkable one.
  if (result.status === "unavailable") return "";

  const allRelevant = result.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );

  if (allRelevant.length === 0 && result.status === "ok" && result.otherFiles.length === 0) return "";

  const sorted = [...allRelevant].sort(bySeverityThenPosition);
  const relevant = sorted.slice(0, MAX_TARGET_LINES);

  const retryNote = result.status === "timeout" && result.retryAttempts > 0
    ? ` after ${result.retryAttempts} ${result.retryAttempts === 1 ? "retry" : "retries"}`
    : "";

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length > 0) {
    return `\n⚠ LSP diagnostics for ${filePath}: no issues${otherFilesFooter(result, cwd)}`;
  }

  const lines = relevant.map((d) => {
    const severity = severityRank(d) === 0 ? "error" : "warning";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? `[${d.source}] ` : "";
    return `  ${severity} ${line}:${col} ${source}${oneLine(diagnosticMessage(d))}`;
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

  const hidden = sorted.length - relevant.length;
  const truncatedNote = hidden > 0 ? `\n  ... and ${hidden} more diagnostics in this file` : "";
  // Files that merely use the changed code are never looked up; the list above only contains files
  // the server reported on by itself. Say so while we already have the reader's attention, instead
  // of letting an empty list read as "nothing else is affected".
  const dependentsNote = result.otherFiles.length === 0
    ? `\n  dependents: not checked (only files the server mentioned were compared)`
    : "";

  return `\n⚠ LSP diagnostics for ${filePath} (${summary}):\n${lines.join("\n")}${truncatedNote}${otherFilesFooter(result, cwd)}${dependentsNote}`;
}

function otherFilesFooter(result: DiagnosticResult, cwd?: string): string {
  if (result.otherFiles.length === 0) return "";

  const rows = result.otherFiles.map((f) => ({ path: displayPath(f.uri, cwd), f }));
  const ordered = [...rows].sort((a, b) =>
    b.f.errorCount - a.f.errorCount ||
    b.f.warningCount - a.f.warningCount ||
    a.path.localeCompare(b.path),
  );
  const shown = ordered.slice(0, MAX_OTHER_FILE_LINES);

  const lines = shown.map(({ path, f }) => {
    const counts = [
      f.errorCount > 0 ? `${f.errorCount} error${f.errorCount > 1 ? "s" : ""}` : "",
      f.warningCount > 0 ? `${f.warningCount} warning${f.warningCount > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    if (!f.firstDiagnostic) return `  ${path} (${counts})`;
    const d = f.firstDiagnostic;
    const sev = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const src = d.source ? `[${d.source}] ` : "";
    return `  ${path} (${counts}): ${sev} ${d.line + 1}:${d.col + 1} ${src}${oneLine(d.message)}`;
  });

  const hidden = ordered.length - shown.length;
  const note = hidden > 0 ? `\n  ... and ${hidden} more file${hidden === 1 ? "" : "s"} with diagnostics` : "";
  return `\n${lines.join("\n")}${note}`;
}

/** Files `/lsp-diag` lists; the rest are counted, not shown. */
const MAX_LEDGER_FILES = 20;
/** Diagnostics shown for one file there — a clang-tidy cascade must not fill the whole notice. */
const MAX_LEDGER_ROWS = 10;

/** A file the ledger can list: what was found, and whether a server still watches it. */
export interface LedgerFile {
  diagnostics: Diagnostic[];
  watched: boolean;
}

/**
 * Everything the footer totals are made of: one block per measured file, errors first, worst file
 * first. `/lsp-diag` prints it under the footer line so a number in the footer can be checked
 * against the files it came from.
 *
 * A file whose document was closed stays and is marked `not watched`: its numbers are the last ones
 * taken, not current ones, and dropping it would read as a clean bill.
 */
export function formatDiagnosticLedger(files: Map<string, LedgerFile>, cwd?: string): string {
  interface LedgerEntry {
    path: string;
    errors: number;
    warnings: number;
    rows: string[];
    hidden: number;
    watched: boolean;
  }

  const entries: LedgerEntry[] = [];
  for (const [uri, file] of files) {
    const relevant = file.diagnostics.filter(
      (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
    );
    if (relevant.length === 0) continue;

    const sorted = [...relevant].sort(bySeverityThenPosition);
    const errors = sorted.reduce((n, d) => n + (severityRank(d) === 0 ? 1 : 0), 0);
    const rows = sorted.slice(0, MAX_LEDGER_ROWS).map((d) => {
      const severity = severityRank(d) === 0 ? "error" : "warning";
      const source = d.source ? `[${d.source}] ` : "";
      return `  ${severity} ${d.range.start.line + 1}:${d.range.start.character + 1} ${source}${oneLine(diagnosticMessage(d))}`;
    });

    entries.push({
      path: displayPath(uri, cwd),
      errors,
      warnings: sorted.length - errors,
      rows,
      hidden: sorted.length - rows.length,
      watched: file.watched,
    });
  }

  if (entries.length === 0) return "";

  entries.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || a.path.localeCompare(b.path));

  const shown = entries.slice(0, MAX_LEDGER_FILES);
  const blocks = shown.map((e) => {
    const counts = [
      e.errors > 0 ? `${e.errors} error${e.errors > 1 ? "s" : ""}` : "",
      e.warnings > 0 ? `${e.warnings} warning${e.warnings > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    const stale = e.watched ? "" : ", last measurement";
    const hidden = e.hidden > 0 ? `\n  ... and ${e.hidden} more in this file` : "";
    return `${e.path} (${counts}${stale}):\n${e.rows.join("\n")}${hidden}`;
  });

  const hiddenFiles = entries.length - shown.length;
  const parts = [blocks.join("\n")];
  if (hiddenFiles > 0) {
    parts.push(`... and ${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"} with diagnostics`);
  }
  const unwatched = shown.filter((e) => !e.watched).length;
  if (unwatched > 0) {
    parts.push(
      `${unwatched} of ${shown.length} ${shown.length === 1 ? "file is" : "files are"} no longer watched: those are the last numbers taken, not current ones.`,
    );
  }
  return parts.join("\n");
}
