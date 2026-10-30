import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import type { DiagnosticResult } from "../../src/client.js";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { recentLogLines } from "../../src/log.js";
import { builtinLanguages as languages } from "../../src/languages.js";
import { pollUntil } from "../poll-until.js";

const cppConfig = languages.find((l) => l.id === "cpp");
if (!cppConfig) throw new Error("cpp config not found in languages");

describe("clangd integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;

  before(async () => {
    manager = createServerManager({ maxRetries: 0 });
    dir = join(tmpdir(), `pi-lsp-cpp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "compile_commands.json"), JSON.stringify([
      { directory: dir, file: "main.c", arguments: ["cc", "-c", "main.c"] },
    ]));

    // warmup using main.c (matches compile_commands.json)
    await writeFile(join(dir, "main.c"), "int main(void) { return 0; }\n");
    const warmup = await manager.handleEdit(join(dir, "main.c"), cppConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "clangd is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports no errors for clean file", async () => {
    await writeFile(join(dir, "main.c"), '#include <stdio.h>\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n');

    const result = await pollUntil(
      () => manager.handleEdit(join(dir, "main.c"), cppConfig, dir),
      (r) => !r.diagnostics.some((d) => d.severity === 1),
    );

    const hasErrors = result.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });

  it("reports syntax error", async () => {
    await writeFile(join(dir, "main.c"), "int main( { return 0; }\n");

    const result = await pollUntil(
      () => manager.handleEdit(join(dir, "main.c"), cppConfig, dir),
      (r) => r.diagnostics.some((d) => d.severity === 1),
    );

    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.some((d) => d.severity === 1), "expected at least one error diagnostic for syntax error");
  });
});

// main.c fails to preprocess unless the compilation database defines PINNED, so
// "wrong compilation database" is a visible marker for *which* database clangd used.
const PIN_MARKER = "wrong compilation database";

describe("clangd --compile-commands-dir precedence", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  const bases: string[] = [];

  before(() => {
    manager = createServerManager({ maxRetries: 0, diagnosticTimeout: 15_000 });
  });

  after(async () => {
    await manager.shutdownAll();
    for (const base of bases) {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });

  // The database lives outside `proj`, so the auto-detect walk (which starts at
  // cwd = proj) can never find it: only a configured flag can bring it in.
  async function makeCase(tag: string): Promise<{ proj: string; db: string; empty: string; file: string }> {
    const base = join(tmpdir(), `pi-lsp-cpp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bases.push(base);
    const proj = join(base, "proj");
    const db = join(base, "db");
    const empty = join(base, "empty");
    const file = join(proj, "main.c");
    await mkdir(proj, { recursive: true });
    await mkdir(db, { recursive: true });
    await mkdir(empty, { recursive: true });
    await writeFile(join(proj, "CMakeLists.txt"), "project(p)\n");
    await writeFile(file, `#ifndef PINNED\n#error "${PIN_MARKER}"\n#endif\nint main(void) { return 0; }\n`);
    await writeFile(join(db, "compile_commands.json"), JSON.stringify([
      { directory: proj, file, arguments: ["cc", "-DPINNED=1", "-c", file] },
    ]));
    return { proj, db, empty, file };
  }

  function logHas(about: string, phrase: string): boolean {
    return recentLogLines(200).some((line) => line.includes(about) && line.includes(phrase));
  }

  // Diagnostic.message is string | MarkupContent in the protocol types
  const messageOf = (d: Diagnostic): string => (typeof d.message === "string" ? d.message : d.message.value);
  const markerError = (r: DiagnosticResult) =>
    r.diagnostics.some((d) => d.severity === 1 && messageOf(d).includes(PIN_MARKER));
  const anyError = (r: DiagnosticResult) =>
    r.diagnostics.some((d) => d.severity === 1);

  it("uses the database pinned in config args and skips the search", async () => {
    const { proj, db, file } = await makeCase("pin");

    const result = await pollUntil(
      () => manager.handleEdit(file, { ...cppConfig, args: [`--compile-commands-dir=${db}`] }, proj),
      (r) => r.status !== "ok" || !anyError(r),
    );

    assert.notEqual(result.status, "unavailable", "clangd is not available — cannot run integration tests");
    assert.equal(markerError(result), false, `expected the pinned database to define PINNED, got: ${result.diagnostics.map(messageOf).join("; ")}`);
    assert.ok(logHas(proj, "auto-detect skipped"), "expected the auto-detect walk to be skipped");

    // a syntax error must still surface: it proves clangd really parsed this file
    await writeFile(file, `#ifndef PINNED\n#error "${PIN_MARKER}"\n#endif\nint main( { return 0; }\n`);
    const broken = await pollUntil(
      () => manager.handleEdit(file, { ...cppConfig, args: [`--compile-commands-dir=${db}`] }, proj),
      (r) => anyError(r),
    );
    assert.ok(anyError(broken), "expected clangd to report the syntax error");
    assert.equal(markerError(broken), false, "pinned database must not be replaced by the auto-detected one");
  });

  it("warns when the pinned directory holds no compile_commands.json", async () => {
    const { proj, empty, file } = await makeCase("badpin");

    const result = await manager.handleEdit(file, { ...cppConfig, args: [`--compile-commands-dir=${empty}`] }, proj);

    assert.notEqual(result.status, "unavailable", "clangd must still start with an unusable pinned path");
    assert.ok(markerError(result), "expected clangd to fall back and report the marker error");
    assert.ok(logHas(empty, "has no compile_commands.json"), "expected a warning about the pinned directory");
  });

  it("reports the marker error when nothing pins the database", async () => {
    const { proj, file } = await makeCase("nopin");

    const result = await pollUntil(
      () => manager.handleEdit(file, cppConfig, proj),
      (r) => markerError(r) || (r.status === "ok" && !anyError(r)),
    );

    assert.ok(markerError(result), "fixture must discriminate: without a database PINNED is undefined");
    assert.equal(logHas(proj, "auto-detect skipped"), false, "nothing is pinned, so the search must run");
  });
});
