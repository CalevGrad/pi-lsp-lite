import type { DiagnosticSummary } from "./server-manager.js";

/** What the last edit told us about the language server itself. */
export type LspHealth = "ok" | "timeout" | "unavailable" | "unknown";

/** The subset of Pi's theme the footer needs. */
export type FooterColor = "error" | "warning" | "success" | "muted";

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
    return `${label("muted")} ${theme.fg("error", "✗ server unavailable")}`;
  }
  if (state.checked === 0) return undefined;

  // The label carries the worst severity, so the state is readable at a glance.
  const labelColor: FooterColor = state.errors > 0 ? "error" : state.warnings > 0 ? "warning" : "muted";

  const parts: string[] = [];
  if (state.errors > 0) parts.push(theme.fg("error", count(state.errors, "error")));
  if (state.warnings > 0) parts.push(theme.fg("warning", count(state.warnings, "warning")));

  if (parts.length === 0) {
    // A timeout with nothing reported proves nothing, so it must not read as clean.
    if (state.health === "timeout") return `${label("muted")} ${theme.fg("warning", "⚠ incomplete")}`;
    return `${label("muted")} ${theme.fg("success", "✓ clean")}`;
  }

  if (state.files > 1) parts.push(theme.fg("muted", `in ${state.files} files`));
  if (state.health === "timeout") parts.push(theme.fg("warning", "· timeout"));

  return `${label(labelColor)} ${parts.join(", ")}`;
}
