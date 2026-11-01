import { stat, readdir, realpath, readFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { type LanguageServerConfig } from "./languages.js";

// clangd discovers a compilation database by probing three names in the
// directory of the source file and then in every parent directory
// (clang-tools-extra/clangd/GlobalCompilationDatabase.cpp, DirectoryCache).
// `build/` is probed exactly one level deep, so build/<config>/compile_commands.json
// is never found. This module mirrors that probe to decide whether clangd needs
// help, and if so, which `build/**` database to hand it via --compile-commands-dir.
const NATIVE_DATABASE_FILES = ["compile_commands.json", join("build", "compile_commands.json"), "compile_flags.txt"];
const NATIVE_CONFIG_FILE = ".clangd";

export const DEFAULT_CDB_GLOBS = ["build/**/compile_commands.json"];
export const DEFAULT_CDB_MAX_DEPTH = 3;

// Databases above this size are accepted but not inspected, so they count as
// "does not cover the file". Keeps a multi-megabyte LLVM database from being
// re-parsed on every edit.
export const MAX_DATABASE_PARSE_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_READ_BYTES = 512 * 1024;
const MAX_ANCESTORS = 64;

export interface CdbCandidate {
  /** Absolute path of the compile_commands.json itself. */
  file: string;
  /** Absolute path of its directory — the value clangd needs. */
  dir: string;
  /** Path segments relative to the workspace root; ties are broken by shallowest. */
  depth: number;
  mtimeMs: number;
  /** True when the database has an entry for the file being edited. */
  coversFile: boolean;
  /** False when the database was too large to inspect. */
  inspected: boolean;
}

export type CdbReason =
  | "disabled"
  | "user-pinned"
  | "native-database"
  | "native-config"
  | "not-found"
  | "outside-root"
  | "single"
  | "file-match"
  | "ambiguous-cover"
  | "ambiguous-none";

export interface CdbResolution {
  /** Directory to pass as --compile-commands-dir, or null to leave clangd alone. */
  dir: string | null;
  reason: CdbReason;
  /** Which ancestor the search stopped at; the base for paths in log messages. */
  root: string | null;
  /** Valid candidates, sorted by the tie-break order used for selection. */
  candidates: CdbCandidate[];
  chosen?: CdbCandidate;
  /** Candidate directories found but rejected for living outside the workspace. */
  outsideRoot: string[];
}

export interface CdbOptions {
  enabled?: boolean;
  globs?: string[];
  maxDepth?: number;
}

interface Pattern {
  /** Matches the workspace-relative path of a candidate file. */
  regex: RegExp;
  /** Literal path prefix before the first wildcard; the walk never leaves it. */
  prefix: string;
  prefixDepth: number;
  /** Set when the pattern has no wildcard, so nothing needs walking. */
  literal: string | null;
}

function pathKey(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Directories to search, nearest first: the file's own directory up to and
 * including `stopAt`. clangd anchors on the file, never on a workspace root, so
 * discovery must too — a root inferred from markers such as CMakeLists.txt can
 * land in a subproject that has no build/ of its own.
 */
export function ancestorsUpTo(filePath: string, stopAt: string): string[] {
  const stop = resolve(stopAt);
  const start = resolve(dirname(filePath));
  // A file outside the workspace gets one anchor: never climb above it looking
  // for someone else's build tree.
  if (!isInside(start, stop)) return [start];

  const roots: string[] = [];
  let dir = start;
  for (;;) {
    roots.push(dir);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** Workspace-relative path with forward slashes, as globs are written. */
function toSlashPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Does clangd already find a database on its own?
// ---------------------------------------------------------------------------

export interface NativeCdb {
  /** A database clangd would load itself: compile_commands.json / compile_flags.txt. */
  database: string | null;
  /** A .clangd fragment that pins the database directory for clangd. */
  config: string | null;
}

async function refersToCompilationDatabase(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return false;
  }
  if (content.length > MAX_CONFIG_READ_BYTES) content = content.slice(0, MAX_CONFIG_READ_BYTES);
  return /^\s*CompilationDatabase\s*:/m.test(content) || /"CompilationDatabase"\s*:/.test(content);
}

/**
 * Walks the ancestors of `filePath` the way clangd does and reports what it would
 * find. Both answers matter: an explicit CompilationDatabase in .clangd replaces
 * clangd's ancestor search, so we must not fight it either.
 */
export async function findNativeCdb(filePath: string): Promise<NativeCdb> {
  let dir = dirname(resolve(filePath));
  const result: NativeCdb = { database: null, config: null };

  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    if (!result.database) {
      for (const rel of NATIVE_DATABASE_FILES) {
        if (await fileStat(join(dir, rel))) {
          result.database = join(dir, rel);
          break;
        }
      }
    }
    if (!result.config && (await refersToCompilationDatabase(join(dir, NATIVE_CONFIG_FILE)))) {
      result.config = join(dir, NATIVE_CONFIG_FILE);
    }
    if (result.database && result.config) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

function segmentToRegExp(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

export function compileGlobs(globs: string[]): Pattern[] {
  return globs.map((raw) => {
    const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = normalized.split("/").filter((s) => s.length > 0);

    let source = "^";
    let literalSegments = 0;
    let seenWildcard = false;
    segments.forEach((segment, index) => {
      if (segment === "**") {
        seenWildcard = true;
        source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
        return;
      }
      if (/[*?]/.test(segment)) seenWildcard = true;
      if (!seenWildcard) literalSegments++;
      source += segmentToRegExp(segment);
      if (index < segments.length - 1) source += "/";
    });

    const literal = seenWildcard ? null : segments.join("/");
    return {
      regex: new RegExp(source + "$"),
      prefix: segments.slice(0, literalSegments).join("/"),
      prefixDepth: literalSegments,
      literal,
    };
  });
}

async function readDirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Lists files matching the patterns, never walking outside the literal prefix of
 * a pattern or deeper than maxDepth. Symlinked directories are followed, with a
 * realpath set cutting cycles.
 */
async function collectFiles(root: string, patterns: Pattern[], maxDepth: number): Promise<Set<string>> {
  const found = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.literal !== null) {
      const target = join(root, pattern.literal);
      if (await fileStat(target)) found.add(target);
      continue;
    }

    // A directory at depth D holds files at depth D+1, so deeper is pointless.
    const maxDirDepth = Math.max(pattern.prefixDepth, maxDepth - 1);
    const visited = new Set<string>();
    const queue: { dir: string; depth: number }[] = [
      { dir: join(root, pattern.prefix), depth: pattern.prefixDepth },
    ];

    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;

      const real = await realpath(dir).catch(() => null);
      if (!real) continue;
      if (visited.has(real)) continue;
      visited.add(real);

      for (const entry of await readDirSafe(dir)) {
        const entryPath = join(dir, entry.name);
        if (entry.isFile()) {
          const rel = toSlashPath(root, entryPath);
          if (rel.split("/").length <= maxDepth && pattern.regex.test(rel)) found.add(entryPath);
        } else if ((entry.isDirectory() || entry.isSymbolicLink()) && depth + 1 <= maxDirDepth) {
          queue.push({ dir: entryPath, depth: depth + 1 });
        }
      }
    }
  }

  return found;
}

/** Reads a database and reports whether it lists `filePath`. */
async function inspectDatabase(
  file: string,
  size: number,
  filePath: string,
): Promise<{ coversFile: boolean; inspected: boolean } | null> {
  if (size > MAX_DATABASE_PARSE_BYTES) {
    // Too big to read on every edit: accept it, but it cannot claim the file.
    return { coversFile: false, inspected: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return null; // not a database clangd could load either
  }
  if (!Array.isArray(parsed)) return null;

  const wanted = pathKey(filePath);
  const databaseDir = dirname(file);

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { file?: unknown; directory?: unknown };
    if (typeof record.file !== "string" || typeof record.directory !== "string") continue;

    // "directory" is the build directory; a relative "file" hangs off it. Falling
    // back to the database's own directory keeps a bogus "directory" from
    // hiding a file that is plainly listed here.
    const candidates = isAbsolute(record.file)
      ? [record.file]
      : [join(resolve(record.directory), record.file), join(databaseDir, record.file)];

    if (candidates.some((candidate) => pathKey(candidate) === wanted)) {
      return { coversFile: true, inspected: true };
    }
  }
  return { coversFile: false, inspected: true };
}

/** Newest mtime wins, then shallowest, then lexicographically smallest path. */
function compareCandidates(a: CdbCandidate, b: CdbCandidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export async function discoverCandidates(
  root: string,
  filePath: string,
  options: CdbOptions = {},
  boundRoot: string = root,
): Promise<{ candidates: CdbCandidate[]; outsideRoot: string[] }> {
  const globs = options.globs ?? DEFAULT_CDB_GLOBS;
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_CDB_MAX_DEPTH);

  // Candidates stay inside the outermost search root, not inside the anchor that
  // happened to match: a symlinked build/ pointing elsewhere is still a guess.
  const realRoot = await realpath(boundRoot).catch(() => resolve(boundRoot));
  const matches = await collectFiles(root, compileGlobs(globs), maxDepth);
  const candidates: CdbCandidate[] = [];
  const outsideRoot: string[] = [];

  for (const file of matches) {
    const st = await fileStat(file);
    if (!st) continue;

    const dir = dirname(file);
    const realDir = await realpath(dir).catch(() => resolve(dir));
    if (!isInside(realDir, realRoot)) {
      outsideRoot.push(dir);
      continue;
    }

    const inspectedResult = await inspectDatabase(file, st.size, filePath);
    if (!inspectedResult) continue; // unloadable by clangd, so useless to us

    candidates.push({
      file,
      dir,
      depth: toSlashPath(root, file).split("/").length,
      mtimeMs: st.mtimeMs,
      coversFile: inspectedResult.coversFile,
      inspected: inspectedResult.inspected,
    });
  }

  candidates.sort(compareCandidates);
  return { candidates, outsideRoot };
}

/**
 * Picks the database to hand clangd. A single candidate needs no justification.
 * With several, "the edited file is listed in exactly one of them" is the only
 * safe signal; otherwise the newest database wins, which may inject the wrong
 * include paths and defines — callers are expected to warn about that.
 */
export function pickCandidate(candidates: CdbCandidate[]): { chosen: CdbCandidate | null; reason: CdbReason } {
  if (candidates.length === 0) return { chosen: null, reason: "not-found" };
  if (candidates.length === 1) return { chosen: candidates[0], reason: "single" };

  const ordered = [...candidates].sort(compareCandidates);
  const covering = ordered.filter((c) => c.coversFile);
  if (covering.length === 1) return { chosen: covering[0], reason: "file-match" };

  const pool = covering.length > 1 ? covering : ordered;
  return { chosen: pool[0], reason: covering.length > 1 ? "ambiguous-cover" : "ambiguous-none" };
}

/**
 * Entry point: decide what clangd needs for `filePath`.
 *
 * `searchRoots` are the directories to probe, nearest first (see ancestorsUpTo);
 * the first one that holds a valid database wins, which is clangd's own rule that
 * a nearer database beats a further one. Returns dir=null whenever clangd can
 * already find a database or the project pins one itself, because
 * --compile-commands-dir disables clangd's own ancestor search outright.
 */
export async function resolveCompileCommandsDir(
  searchRoots: string | string[],
  filePath: string,
  options: CdbOptions = {},
): Promise<CdbResolution> {
  if (options.enabled === false) {
    return { dir: null, reason: "disabled", root: null, candidates: [], outsideRoot: [] };
  }

  const native = await findNativeCdb(filePath);
  if (native.database) {
    return { dir: null, reason: "native-database", root: null, candidates: [], outsideRoot: [] };
  }
  if (native.config) {
    return { dir: null, reason: "native-config", root: null, candidates: [], outsideRoot: [] };
  }

  const roots = Array.isArray(searchRoots) ? searchRoots : [searchRoots];
  const bound = roots.length > 0 ? roots[roots.length - 1] : process.cwd();
  const seen = new Set<string>();
  const outsideRoot = new Set<string>();

  for (const root of roots) {
    const found = await discoverCandidates(root, filePath, options, bound);
    for (const dir of found.outsideRoot) outsideRoot.add(dir);

    // A glob without a literal prefix re-enters the same subtree from every
    // ancestor; a database is only allowed to be reported once, by its nearest anchor.
    const candidates = found.candidates.filter((c) => {
      if (seen.has(c.file)) return false;
      seen.add(c.file);
      return true;
    });
    if (candidates.length === 0) continue;

    const { chosen, reason } = pickCandidate(candidates);
    if (!chosen) continue;
    return { dir: chosen.dir, reason, root, candidates, chosen, outsideRoot: [...outsideRoot] };
  }

  return {
    dir: null,
    reason: outsideRoot.size > 0 ? "outside-root" : "not-found",
    root: null,
    candidates: [],
    outsideRoot: [...outsideRoot],
  };
}

// ---------------------------------------------------------------------------
// Turning a resolution into clangd arguments
// ---------------------------------------------------------------------------

const EXPLICIT_CDB_ARGS = ["--compile-commands-dir", "--compile_commands_dir", "--compile_args_from", "--compile-args-from"];

/** Discovery is opt-in per server: only clangd-family servers understand the flag. */
export function isDiscoveryEnabled(config: LanguageServerConfig): boolean {
  return config.cdbAutoDiscover === true;
}

/** True when the user already controls where clangd looks for compile commands. */
export function hasExplicitCompileCommandsArg(args: string[]): boolean {
  return args.some((arg) =>
    EXPLICIT_CDB_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`) || arg.startsWith(`${flag}:`)),
  );
}

export interface AppliedCdb {
  config: LanguageServerConfig;
  resolution: CdbResolution;
}

/** Adds --compile-commands-dir unless the user already pinned a database location. */
export function withCompileCommandsArg(config: LanguageServerConfig, dir: string | null): LanguageServerConfig {
  if (!dir || hasExplicitCompileCommandsArg(config.args)) return config;
  return { ...config, args: [...config.args, `--compile-commands-dir=${dir}`] };
}

export async function applyCompileCommandsDiscovery(
  config: LanguageServerConfig,
  searchRoots: string | string[],
  filePath: string,
): Promise<AppliedCdb> {
  // Cheapest checks first, and both are user intent: an opt-out, then a database
  // the user already pointed at. Neither should touch the filesystem.
  const refused = (reason: CdbReason): AppliedCdb => ({
    config,
    resolution: { dir: null, reason, root: null, candidates: [], outsideRoot: [] },
  });
  if (!isDiscoveryEnabled(config)) return refused("disabled");
  if (hasExplicitCompileCommandsArg(config.args)) return refused("user-pinned");

  const resolution = await resolveCompileCommandsDir(searchRoots, filePath, {
    enabled: config.cdbAutoDiscover,
    globs: config.cdbGlobs,
    maxDepth: config.cdbMaxDepth,
  });

  return { config: withCompileCommandsArg(config, resolution.dir), resolution };
}

/** Human-readable explanation for the log; null when there is nothing to report. */
export function describeResolution(resolution: CdbResolution, root: string): string | null {
  const base = resolution.root ?? root;
  const rel = (path: string) => toSlashPath(base, path);
  const chosen = resolution.chosen;

  if (!chosen) {
    if (resolution.reason === "outside-root") {
      return `ignored compilation database outside the workspace root: ${resolution.outsideRoot.join(", ")}`;
    }
    return null;
  }

  if (resolution.reason === "single" || resolution.reason === "file-match") {
    return `using compilation database at ${rel(chosen.dir)}`;
  }

  const why = resolution.reason === "ambiguous-cover"
    ? `all ${resolution.candidates.length} databases cover the edited file`
    : `none of the ${resolution.candidates.length} databases covers the edited file`;

  return [
    `ambiguous compilation databases (${why}) — using the newest: ${rel(chosen.dir)}`,
    ...resolution.candidates.map((c) => `  ${rel(c.file)}`),
    `a wrong database injects wrong include paths and defines; pin one with`,
    `  { "servers": { "<id>": { "cdbGlobs": ["${rel(chosen.file)}"] } } }`,
  ].join("\n");
}
