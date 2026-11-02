import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFooterStatus, type FooterState, type FooterTheme } from "../src/footer.js";

// Colors become visible markers, so one assertion checks text and color together.
const theme: FooterTheme = { fg: (color, text) => `[${color}]${text}` };

function state(overrides: Partial<FooterState>): FooterState {
  return { errors: 0, warnings: 0, files: 0, checked: 0, health: "unknown", unavailable: [], ...overrides };
}

describe("formatFooterStatus", () => {
  it("clears the status when nothing has been analyzed", () => {
    assert.equal(formatFooterStatus(state({ checked: 0, health: "ok" }), theme), undefined);
  });

  it("reports an unavailable server even with nothing analyzed", () => {
    const text = formatFooterStatus(state({ checked: 0, unavailable: ["typescript"] }), theme);
    assert.equal(text, "[error]LSP: [error]1 server unavailable");
  });

  it("counts dead servers without naming them", () => {
    const text = formatFooterStatus(state({ checked: 0, unavailable: ["go", "python", "typescript"] }), theme);
    assert.equal(text, "[error]LSP: [error]3 servers unavailable");
  });

  it("says clean in plain text when a live server found nothing", () => {
    const text = formatFooterStatus(state({ checked: 4, health: "ok" }), theme);
    assert.equal(text, "LSP: clean");
  });

  it("does not call a timed-out zero count clean", () => {
    const text = formatFooterStatus(state({ checked: 2, health: "timeout" }), theme);
    assert.equal(text, "[error]LSP: [error]incomplete");
  });

  it("colors the label with the error severity", () => {
    const text = formatFooterStatus(state({ errors: 1, files: 1, checked: 2, health: "ok" }), theme);
    assert.equal(text, "[error]LSP: [error]1 error");
  });

  it("colors the label yellow when only warnings", () => {
    const text = formatFooterStatus(state({ warnings: 2, files: 1, checked: 2, health: "ok" }), theme);
    assert.equal(text, "[warning]LSP: [warning]2 warnings");
  });

  it("names the file count when issues span several files", () => {
    const text = formatFooterStatus(state({ errors: 2, warnings: 1, files: 3, checked: 6, health: "ok" }), theme);
    assert.equal(text, "[error]LSP: [error]2 errors, [warning]1 warning [muted]in 3 files");
  });

  it("omits the file count when one file holds every issue", () => {
    const text = formatFooterStatus(state({ errors: 2, warnings: 1, files: 1, checked: 6, health: "ok" }), theme);
    assert.equal(text, "[error]LSP: [error]2 errors, [warning]1 warning");
  });

  it("appends the timeout note after the counts", () => {
    const text = formatFooterStatus(state({ errors: 1, files: 1, checked: 2, health: "timeout" }), theme);
    assert.equal(text, "[error]LSP: [error]1 error [error]· timeout");
  });

  it("keeps the timeout note out of the comma list", () => {
    const text = formatFooterStatus(
      state({ errors: 2, warnings: 1, files: 3, checked: 6, health: "timeout" }),
      theme,
    );
    assert.equal(text, "[error]LSP: [error]2 errors, [warning]1 warning [muted]in 3 files [error]· timeout");
  });

  // A live server's counts are the reason this row exists; a dead one may not hide them.
  it("keeps a live server's counts when another one is dead", () => {
    const text = formatFooterStatus(
      state({ errors: 3, warnings: 1, files: 2, checked: 3, health: "ok", unavailable: ["typescript"] }),
      theme,
    );
    assert.equal(text, "[error]LSP: [error]3 errors, [warning]1 warning [muted]in 2 files [error]· 1 server unavailable");
  });

  it("does not call a session clean while a server is dead", () => {
    const text = formatFooterStatus(state({ checked: 2, health: "ok", unavailable: ["python"] }), theme);
    assert.equal(text, "LSP: clean [error]· 1 server unavailable");
  });

  it("keeps the timeout note when a server is dead too", () => {
    const text = formatFooterStatus(
      state({ errors: 2, files: 1, checked: 2, health: "timeout", unavailable: ["typescript"] }),
      theme,
    );
    assert.equal(text, "[error]LSP: [error]2 errors [error]· timeout [error]· 1 server unavailable");
  });

  it("marks incomplete counts red even with a dead server noted", () => {
    const text = formatFooterStatus(
      state({ checked: 2, health: "timeout", unavailable: ["go", "python"] }),
      theme,
    );
    assert.equal(text, "[error]LSP: [error]incomplete [error]· 2 servers unavailable");
  });
});
