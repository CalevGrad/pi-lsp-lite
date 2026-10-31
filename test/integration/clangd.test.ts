import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";
import { pollUntil } from "../poll-until.js";

function cdbArg(status: { args: string[] } | undefined): string | undefined {
  return status?.args.find((arg) => arg.startsWith("--compile-commands-dir="));
}

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

// Regression for the layout clangd cannot see: the database lives two levels
// below the root, inside a named build directory. Without discovery clangd
// falls back to `clang main.cpp` and reports widget.h as missing.
describe("clangd integration with a nested compilation database", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;
  let mainPath: string;

  before(async () => {
    manager = createServerManager({ maxRetries: 0 });
    dir = join(tmpdir(), `pi-lsp-cpp-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const includeDir = join(dir, "include");
    const srcDir = join(dir, "src");
    const buildDir = join(dir, "build", "debug-x64");
    await mkdir(includeDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    // The source lives in a subproject with its own CMakeLists.txt, so the
    // workspace root resolves there and has no build/ of its own.
    mainPath = join(srcDir, "main.cpp");
    await writeFile(join(dir, "CMakeLists.txt"), "project(demo)\n");
    await writeFile(join(srcDir, "CMakeLists.txt"), "project(demo_src)\n");
    await writeFile(join(includeDir, "widget.h"), "inline int widget_value() { return 42; }\n");
    await writeFile(mainPath, '#include "widget.h"\nint main() { return widget_value(); }\n');
    await writeFile(join(buildDir, "compile_commands.json"), JSON.stringify([
      {
        directory: buildDir,
        file: mainPath,
        arguments: ["clang++", `-I${includeDir}`, "-std=c++17", "-c", mainPath],
      },
    ]));
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("proves the layout really is invisible to clangd without discovery", async () => {
    const plain = createServerManager({ maxRetries: 0 });
    const withoutDiscovery = { ...cppConfig, id: "cpp-plain", cdbAutoDiscover: false };

    const result = await pollUntil(
      () => plain.handleEdit(mainPath, withoutDiscovery, dir),
      (r) => r.diagnostics.length > 0 || r.status !== "ok",
    );

    assert.equal(cdbArg(plain.status()[0]), undefined);
    assert.ok(
      result.diagnostics.some((d) => /widget\.h.*not found|not found.*widget\.h/i.test(String(d.message))),
      `expected a missing-include diagnostic, got ${JSON.stringify(result.diagnostics.map((d) => String(d.message)))}`,
    );

    await plain.shutdownAll();
  });

  it("finds the include path that only the nested database provides", async () => {
    const result = await pollUntil(
      () => manager.handleEdit(mainPath, cppConfig, dir),
      (r) => r.status === "ok",
    );

    assert.notEqual(result.status, "unavailable", "clangd is not available — cannot run integration tests");
    assert.equal(cdbArg(manager.status()[0]), `--compile-commands-dir=${join(dir, "build/debug-x64")}`);

    const missing = result.diagnostics.filter((d) => /not found/i.test(String(d.message)));
    assert.deepEqual(missing.map((d) => d.message), [], "clangd parsed main.cpp without the database's -I");
  });
});
