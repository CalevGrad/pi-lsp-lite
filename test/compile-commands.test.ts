import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink, utimes } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  findNativeCdb,
  discoverCandidates,
  pickCandidate,
  resolveCompileCommandsDir,
  hasExplicitCompileCommandsArg,
  withCompileCommandsArg,
  applyCompileCommandsDiscovery,
  describeResolution,
  type CdbCandidate,
} from "../src/compile-commands.js";
import { type LanguageServerConfig } from "../src/languages.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lsp-cdb-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function write(path: string, content = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** compile_commands.json listing exactly these source files. */
function database(files: string[], directory = "."): string {
  return JSON.stringify(
    files.map((file) => ({ directory, file, command: "clang++ -c " + file })),
    null,
    2,
  );
}
/** mtime to a fixed wall-clock second so ordering tests never depend on timing. */
async function stamp(path: string, epochSeconds: number): Promise<void> {
  const t = new Date(epochSeconds * 1000);
  await utimes(path, t, t);
}

const cppServer: LanguageServerConfig = {
  id: "cpp",
  extensions: [".cpp"],
  command: "clangd",
  args: [],
  rootPatterns: ["compile_commands.json"],
};

function candidate(overrides: Partial<CdbCandidate> & { file: string }): CdbCandidate {
  return {
    dir: dirname(overrides.file),
    depth: 2,
    mtimeMs: 0,
    coversFile: false,
    inspected: true,
    ...overrides,
  };
}

describe("findNativeCdb", () => {
  it("finds nothing in a bare tree", async () => {
    const root = await makeTempDir();
    await write(join(root, "src/main.cpp"));
    assert.deepEqual(await findNativeCdb(join(root, "src/main.cpp")), { database: null, config: null });
  });

  it("finds a database in the file's own directory", async () => {
    const root = await makeTempDir();
    await write(join(root, "src/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));
    const hit = await findNativeCdb(join(root, "src/main.cpp"));
    assert.equal(hit.database, join(root, "src/compile_commands.json"));
  });

  it("walks up to an ancestor database", async () => {
    const root = await makeTempDir();
    await write(join(root, "compile_commands.json"), database([]));
    await write(join(root, "src/deep/main.cpp"));
    const hit = await findNativeCdb(join(root, "src/deep/main.cpp"));
    assert.equal(hit.database, join(root, "compile_commands.json"));
  });

  it("sees build/compile_commands.json, the one level clangd probes", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));
    const hit = await findNativeCdb(join(root, "src/main.cpp"));
    assert.equal(hit.database, join(root, "build/compile_commands.json"));
  });

  it("treats compile_flags.txt as a database clangd will use", async () => {
    const root = await makeTempDir();
    await write(join(root, "compile_flags.txt"), "-Iinclude");
    await write(join(root, "src/main.cpp"));
    const hit = await findNativeCdb(join(root, "src/main.cpp"));
    assert.ok(hit.database?.endsWith("compile_flags.txt"));
  });

  it("does not see build/debug-x64/compile_commands.json, which is the whole problem", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));
    assert.equal((await findNativeCdb(join(root, "src/main.cpp"))).database, null);
  });

  it("reports a .clangd that pins CompilationDatabase", async () => {
    const root = await makeTempDir();
    await write(join(root, ".clangd"), "CompileFlags:\n  CompilationDatabase: out/build\n");
    await write(join(root, "src/main.cpp"));
    const hit = await findNativeCdb(join(root, "src/main.cpp"));
    assert.equal(hit.config, join(root, ".clangd"));
    assert.equal(hit.database, null);
  });

  it("ignores a .clangd that says nothing about the database", async () => {
    const root = await makeTempDir();
    await write(join(root, ".clangd"), "CompileFlags:\n  Add: [-Wall]\n");
    await write(join(root, "src/main.cpp"));
    assert.equal((await findNativeCdb(join(root, "src/main.cpp"))).config, null);
  });
});

describe("discoverCandidates", () => {
  it("finds a database one level under build/", async () => {
    const root = await makeTempDir();
    const source = join(root, "src/main.cpp");
    await write(join(root, "build/debug-x64/compile_commands.json"), database([source]));
    await write(source);

    const { candidates } = await discoverCandidates(root, source);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].dir, join(root, "build/debug-x64"));
    assert.equal(candidates[0].coversFile, true);
  });

  it("matches an entry whose file is relative to directory", async () => {
    const root = await makeTempDir();
    const source = join(root, "src/main.cpp");
    const buildDir = join(root, "build/debug-x64");
    await write(join(buildDir, "compile_commands.json"), database(["../../src/main.cpp"], buildDir));
    await write(source);

    const { candidates } = await discoverCandidates(root, source);
    assert.equal(candidates[0].coversFile, true);
  });

  it("stops at maxDepth", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/a/b/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    assert.equal((await discoverCandidates(root, join(root, "src/main.cpp"))).candidates.length, 0);
    const deeper = await discoverCandidates(root, join(root, "src/main.cpp"), { maxDepth: 4 });
    assert.equal(deeper.candidates.length, 1);
  });

  it("honours a narrowed glob", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "build/release-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const { candidates } = await discoverCandidates(root, join(root, "src/main.cpp"), {
      globs: ["build/debug-*/**/compile_commands.json"],
    });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].dir, /debug-x64$/);
  });

  it("accepts a literal glob as a plain path check", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const { candidates } = await discoverCandidates(root, join(root, "src/main.cpp"), {
      globs: ["build/debug-x64/compile_commands.json"],
    });
    assert.equal(candidates.length, 1);
  });

  it("drops a database that is not valid JSON, keeping the good one", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/broken/compile_commands.json"), "{ this is not json");
    await write(join(root, "build/good/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const { candidates } = await discoverCandidates(root, join(root, "src/main.cpp"));
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].dir, /good$/);
  });

  it("drops a database outside the workspace root", async () => {
    const parent = await makeTempDir();
    const root = join(parent, "proj");
    await mkdir(root, { recursive: true });
    await write(join(parent, "elsewhere/debug/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));
    await symlink(join(parent, "elsewhere"), join(root, "build"), "dir");

    const { candidates, outsideRoot } = await discoverCandidates(root, join(root, "src/main.cpp"));
    assert.equal(candidates.length, 0);
    assert.equal(outsideRoot.length, 1);
  });

  it("follows symlinked build directories without looping", async () => {
    const root = await makeTempDir();
    const source = join(root, "src/main.cpp");
    // build/linked -> storage/dbg, and storage/dbg/self points back at build/.
    // Without the realpath guard the walk would cycle; the depth cap alone would
    // only stop it after maxDepth levels.
    await write(join(root, "storage/dbg/compile_commands.json"), database([source]));
    await write(source);
    await mkdir(join(root, "build"), { recursive: true });
    await symlink(join(root, "storage/dbg"), join(root, "build/linked"), "dir");
    await symlink(join(root, "build"), join(root, "storage/dbg/self"), "dir");

    const { candidates } = await discoverCandidates(root, source);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].file, /build\/linked\/compile_commands\.json$/);
    assert.equal(candidates[0].coversFile, true);
  });
});

describe("pickCandidate", () => {
  it("reports not-found for an empty list", () => {
    assert.deepEqual(pickCandidate([]), { chosen: null, reason: "not-found" });
  });

  it("takes the only candidate without justification", () => {
    const one = candidate({ file: "/r/build/dbg/compile_commands.json" });
    const { chosen, reason } = pickCandidate([one]);
    assert.equal(reason, "single");
    assert.equal(chosen?.file, one.file);
  });

  it("prefers the database that lists the file over a newer one", () => {
    const older = candidate({
      file: "/r/build/debug/compile_commands.json",
      mtimeMs: 1_000,
      coversFile: true,
    });
    const newer = candidate({ file: "/r/build/release/compile_commands.json", mtimeMs: 2_000 });
    const { chosen, reason } = pickCandidate([newer, older]);
    assert.equal(reason, "file-match");
    assert.equal(chosen?.file, older.file);
  });

  it("falls back to the newest when nothing lists the file", () => {
    const a = candidate({ file: "/r/build/debug/compile_commands.json", mtimeMs: 1_000 });
    const b = candidate({ file: "/r/build/release/compile_commands.json", mtimeMs: 2_000 });
    const { chosen, reason } = pickCandidate([a, b]);
    assert.equal(reason, "ambiguous-none");
    assert.equal(chosen?.file, b.file);
  });

  it("falls back to the newest when everything lists the file", () => {
    const a = candidate({ file: "/r/build/debug/compile_commands.json", mtimeMs: 1_000, coversFile: true });
    const b = candidate({ file: "/r/build/release/compile_commands.json", mtimeMs: 2_000, coversFile: true });
    const { chosen, reason } = pickCandidate([a, b]);
    assert.equal(reason, "ambiguous-cover");
    assert.equal(chosen?.file, b.file);
  });

  it("breaks an mtime tie by shallower depth, then by path", () => {
    const deep = candidate({ file: "/r/build/x/y/compile_commands.json", depth: 4, mtimeMs: 5 });
    const shallow = candidate({ file: "/r/build/z/compile_commands.json", depth: 3, mtimeMs: 5 });
    assert.equal(pickCandidate([deep, shallow]).chosen?.file, shallow.file);

    const b = candidate({ file: "/r/build/b/compile_commands.json", mtimeMs: 5 });
    const a = candidate({ file: "/r/build/a/compile_commands.json", mtimeMs: 5 });
    assert.equal(pickCandidate([b, a]).chosen?.file, a.file);
  });
});

describe("resolveCompileCommandsDir", () => {
  it("stays out of the way when clangd already finds a database", async () => {
    const root = await makeTempDir();
    await write(join(root, "compile_commands.json"), database([]));
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const result = await resolveCompileCommandsDir(root, join(root, "src/main.cpp"));
    assert.equal(result.dir, null);
    assert.equal(result.reason, "native-database");
  });

  it("stays out of the way when .clangd pins a database", async () => {
    const root = await makeTempDir();
    await write(join(root, ".clangd"), "CompileFlags:\n  CompilationDatabase: build\n");
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const result = await resolveCompileCommandsDir(root, join(root, "src/main.cpp"));
    assert.equal(result.dir, null);
    assert.equal(result.reason, "native-config");
  });

  it("points clangd at build/debug-x64 when it would otherwise find nothing", async () => {
    const root = await makeTempDir();
    const source = join(root, "src/main.cpp");
    await write(join(root, "build/debug-x64/compile_commands.json"), database([source]));
    await write(source);

    const result = await resolveCompileCommandsDir(root, source);
    assert.equal(result.dir, join(root, "build/debug-x64"));
    assert.equal(result.reason, "single");
  });

  it("does nothing when disabled", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const result = await resolveCompileCommandsDir(root, join(root, "src/main.cpp"), { enabled: false });
    assert.deepEqual(result, { dir: null, reason: "disabled", candidates: [], outsideRoot: [] });
  });

  it("reports outside-root when that is the only thing found", async () => {
    const parent = await makeTempDir();
    const root = join(parent, "proj");
    await mkdir(root, { recursive: true });
    await write(join(parent, "elsewhere/debug/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));
    await symlink(join(parent, "elsewhere"), join(root, "build"), "dir");

    const result = await resolveCompileCommandsDir(root, join(root, "src/main.cpp"));
    assert.equal(result.dir, null);
    assert.equal(result.reason, "outside-root");
  });
});

describe("argument injection", () => {
  it("recognizes the flags that already pin a database", () => {
    assert.equal(hasExplicitCompileCommandsArg(["--compile-commands-dir=/x"]), true);
    assert.equal(hasExplicitCompileCommandsArg(["--compile-commands-dir", "/x"]), true);
    assert.equal(hasExplicitCompileCommandsArg(["--compile_args_from=lsp"]), true);
    assert.equal(hasExplicitCompileCommandsArg(["--background-index"]), false);
  });

  it("appends the flag and never overrides an explicit one", () => {
    const withDir = withCompileCommandsArg(cppServer, "/repo/build/debug-x64");
    assert.deepEqual(withDir.args, ["--compile-commands-dir=/repo/build/debug-x64"]);
    assert.deepEqual(cppServer.args, [], "the input config must not be mutated");

    const pinned = { ...cppServer, args: ["--compile-commands-dir=/mine"] };
    assert.deepEqual(withCompileCommandsArg(pinned, "/other").args, ["--compile-commands-dir=/mine"]);
  });

  it("leaves servers that did not opt in completely alone", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const goLike: LanguageServerConfig = { ...cppServer, id: "go", cdbAutoDiscover: undefined };
    const applied = await applyCompileCommandsDiscovery(goLike, root, join(root, "src/main.cpp"));
    assert.deepEqual(applied.config.args, []);
    assert.equal(applied.resolution.reason, "disabled");
  });

  it("appends the discovered directory for an opted-in server", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "src/main.cpp"));

    const applied = await applyCompileCommandsDiscovery({ ...cppServer, cdbAutoDiscover: true }, root, join(root, "src/main.cpp"));
    assert.deepEqual(applied.config.args, [`--compile-commands-dir=${join(root, "build/debug-x64")}`]);
  });
});

describe("describeResolution", () => {
  it("is silent when nothing was chosen and nothing was rejected", async () => {
    const root = await makeTempDir();
    const resolution = await resolveCompileCommandsDir(root, join(root, "main.cpp"));
    assert.equal(describeResolution(resolution, root), null);
  });

  it("reports the chosen database relative to the root", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "main.cpp"));

    const resolution = await resolveCompileCommandsDir(root, join(root, "main.cpp"));
    assert.match(describeResolution(resolution, root) ?? "", /build\/debug-x64/);
  });

  it("lists every candidate and how to pin one when it had to guess", async () => {
    const root = await makeTempDir();
    await write(join(root, "build/debug-x64/compile_commands.json"), database([]));
    await write(join(root, "build/release-x64/compile_commands.json"), database([]));
    await write(join(root, "main.cpp"));
    await stamp(join(root, "build/debug-x64/compile_commands.json"), 1_700_000_000);
    await stamp(join(root, "build/release-x64/compile_commands.json"), 1_700_000_600);

    const resolution = await resolveCompileCommandsDir(root, join(root, "main.cpp"));
    const message = describeResolution(resolution, root) ?? "";

    assert.equal(resolution.reason, "ambiguous-none");
    assert.match(message, /build\/debug-x64\/compile_commands\.json/);
    assert.match(message, /build\/release-x64\/compile_commands\.json/);
    assert.match(message, /newest: build\/release-x64/);
    assert.match(message, /cdbGlobs/);
  });
});
