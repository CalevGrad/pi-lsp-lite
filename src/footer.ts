import type { DiagnosticSummary } from "./server-manager.js";

/** What the language servers last told us; "unknown" until the first edit of the session. */
export type LspHealth = "ok" | "timeout" | "unavailable" | "unknown";

/** The subset of Pi's theme the footer needs. */
export type FooterColor = "error" | "warning" | "muted";

export interface FooterTheme {
  fg(color: FooterColor, text: string): string;
}

export interface FooterState extends DiagnosticSummary {
  /** Documents open in live servers. Zero means nothing has been analyzed. */
  checked: number;
  health: LspHealth;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Footer text for `ctx.ui.setStatus()`, or undefined to clear the status.
 *
 * Undefined matters: with no server holding a document, a zero count means
 * "nothing was analyzed", not "the code is clean", and saying clean would be a lie.
 */
export function formatFooterStatus(state: FooterState, theme: FooterTheme): string | undefined {
  const label = (color: FooterColor) => theme.fg(color, "LSP:");

  if (state.health === "unavailable") {
    return `${label("error")} ${theme.fg("error", "server unavailable")}`;
  }
  if (state.checked === 0) return undefined;

  // The label carries the worst severity, so the state is readable at a glance.
  // Only reached with at least one issue, hence no muted case here.
  const labelColor: FooterColor = state.errors > 0 ? "error" : "warning";

  const parts: string[] = [];
  if (state.errors > 0) parts.push(theme.fg("error", count(state.errors, "error")));
  if (state.warnings > 0) parts.push(theme.fg("warning", count(state.warnings, "warning")));

  if (parts.length === 0) {
    // A timeout with nothing reported proves nothing, so it must not read as clean.
    if (state.health === "timeout") return `${label("error")} ${theme.fg("error", "incomplete")}`;
    // Clean gets no color at all: it is the absence of news, not news worth highlighting.
    return `LSP: clean`;
  }

  // Numbers take the comma list; the notes after them take spaces. "in 3 files" and a timeout
  // remark are both remarks about the numbers, so neither may join the list. "· timeout" shares
  // "incomplete"'s red: it makes the counts a floor, not a total.
  const notes: string[] = [];
  if (state.files > 1) notes.push(theme.fg("muted", `in ${state.files} files`));
  if (state.health === "timeout") notes.push(theme.fg("error", "· timeout"));

  const tail = notes.length ? ` ${notes.join(" ")}` : "";
  return `${label(labelColor)} ${parts.join(", ")}${tail}`;
}
