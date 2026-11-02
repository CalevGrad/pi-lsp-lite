import { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import spawn from "cross-spawn";
import { which, fileUri, findWorkspaceRoot } from "./util.js";
import { errText, log } from "./log.js";
import { createLspClient, type LspClient, type DiagnosticResult } from "./client.js";
import { type LanguageServerConfig, languageIdForFile } from "./languages.js";
import {
  ancestorsUpTo,
  applyCompileCommandsDiscovery,
  describeResolution,
  hasExplicitCompileCommandsArg,
  isDiscoveryEnabled,
  withCompileCommandsArg,
  type AppliedCdb,
  type CdbResolution,
} from "./compile-commands.js";
import { DEFAULT_DIAGNOSTIC_TIMEOUT, DEFAULT_DOCUMENT_IDLE_TIMEOUT, DEFAULT_MAX_RETRIES, DEFAULT_SERVER_IDLE_TIMEOUT } from "./config.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** What the server was last given for a document, as recorded on disk. */
interface DocumentStamp {
  mtimeMs: number;
  size: number;
  /**
   * Hash of the exact text sent to the server. mtime and size cannot answer "did the text change":
   * a rewrite with identical content moves mtime and changes nothing else.
   */
  textHash: string;
}

interface OpenDocument extends DocumentStamp {
  lastActivity: number;
}

interface ManagedServer {
  config: LanguageServerConfig;
  serverKey: string;
  root: string;
  process: ChildProcess;
  client: LspClient;
  openDocuments: Map<string, OpenDocument>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastActivity: number;
  editQueue: Promise<DiagnosticResult>;
  /** argv the process was actually spawned with. */
  args: string[];
  /** Compilation database baked into those args, if any. */
  cdbDir: string | null;
  /** The database file itself; its disappearance is what justifies a restart. */
  cdbFile: string | null;
}

/** Findings for one file, plus whether a live server still watches it. */
export interface FileFindings {
  diagnostics: Diagnostic[];
  watched: boolean;
}

export interface ServerManager {
  handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult>;
  status(): ServerStatus[];
  /** Error and warning totals over every live server, for the footer. */
  diagnosticSummary(): DiagnosticSummary;
  /**
   * Findings behind those totals: uri -> diagnostics and whether the file is still watched. Kept
   * when a document closes, because a file we stopped watching is not a clean file. Dropped when the
   * file is deleted or its server dies.
   */
  getAllDiagnostics(): Map<string, FileFindings>;
  /** Documents at least one answer arrived for, watched or not. Zero means nothing was measured. */
  measuredDocuments(): number;
  /** Stops running servers (all, or only one id) so the next edit respawns them with current config. */
  restart(id?: string): Promise<number>;
  shutdownAll(): Promise<void>;
}

export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  /** Files holding at least one error or warning. */
  files: number;
  /**
   * Ids of servers an edit reached but could not use: no binary on PATH, or `initialize` failed
   * for that root. Only languages that were actually edited appear — the footer must not
   * announce a dead server for a language nobody touched this session.
   */
  unavailable: string[];
}

export interface ServerStatus {
  id: string;
  root: string;
  pid: number;
  uptime: number;
  openDocuments: number;
  lastActivity: number;
  /** argv the process was actually spawned with. */
  args: string[];
}

const INIT_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
// Matches clangd's own RevalidateMissingAfter: how often we re-probe the
// filesystem for a compilation database that was not there last time.
const CDB_REVALIDATE_MS = 30_000;
// A build that deletes and regenerates its database must not cause respawn storms.
const CDB_RESTART_COOLDOWN_MS = 10_000;
const MAX_CDB_CACHE_ENTRIES = 256;

export interface ServerManagerOptions {
  diagnosticTimeout?: number;
  documentIdleTimeout?: number;
  /** Milliseconds without edits before a server is stopped. 0 stops never. */
  serverIdleTimeout?: number;
  perServerTimeout?: Map<string, number>;
  maxRetries?: number;
}

const RETRY_BASE_DELAY_MS = 500;
/**
 * How long to wait when the text did not change. The answer is already cached, so this only covers
 * the quiescence window; no retries, because a server with nothing new to say stays silent.
 */
const UNCHANGED_TEXT_WAIT_MS = 1_000;

/** Identity of a document's text. mtime and size cannot tell a rewrite from a no-op. */
function hashText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("base64");
}
const MAX_RETRY_DELAY_MS = 30_000;

export function createServerManager(options: ServerManagerOptions = {}): ServerManager {
  const diagnosticTimeout = options.diagnosticTimeout ?? DEFAULT_DIAGNOSTIC_TIMEOUT;
  const documentIdleTimeout = options.documentIdleTimeout ?? DEFAULT_DOCUMENT_IDLE_TIMEOUT;
  const serverIdleTimeout = options.serverIdleTimeout ?? DEFAULT_SERVER_IDLE_TIMEOUT;
  const perServerTimeout = options.perServerTimeout ?? new Map();
  const defaultMaxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const servers = new Map<string, ManagedServer>();
  const pending = new Map<string, Promise<ManagedServer | null>>();
  const disabledBinaries = new Set<string>();
  const failedRoots = new Set<string>();
  const cdbCache = new Map<string, { resolution: CdbResolution; expiresAt: number }>();
  const cdbAnnounced = new Set<string>();
  const cdbRestarts = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function startSweepTimer() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const server of servers.values()) {
        const stale = [...server.openDocuments.entries()]
          .filter(([, doc]) => now - doc.lastActivity > documentIdleTimeout);
        for (const [docUri] of stale) {
          server.client.didClose(docUri);
          server.openDocuments.delete(docUri);
        }
      }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  function stopSweepTimer() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function resetIdleTimer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    server.lastActivity = Date.now();
    if (serverIdleTimeout === 0) return;
    server.idleTimer = setTimeout(() => shutdownServer(server), serverIdleTimeout);
  }

  async function killProcess(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  async function shutdownServer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    await server.client.shutdown();
    await killProcess(server.process);
    if (servers.get(server.serverKey) === server) {
      servers.delete(server.serverKey);
    }
    if (servers.size === 0) stopSweepTimer();
  }

  async function spawnServer(
    config: LanguageServerConfig,
    root: string,
    serverKey: string,
    resolution: CdbResolution,
  ): Promise<ManagedServer | null> {
    if (disabledBinaries.has(config.id)) return null;
    if (failedRoots.has(serverKey)) return null;

    const binaryPath = await which(config.command);
    if (!binaryPath) {
      log.warning(config.id, `${config.command} not found on PATH, disabling ${config.id}`);
      disabledBinaries.add(config.id);
      return null;
    }

    const child = spawn(binaryPath, config.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      log.info(`${config.id}:${root}`, chunk.toString().trimEnd());
    });

    child.on("error", (err) => {
      log.error(`${config.id}:${root}`, `process error: ${errText(err)}`);
    });

    const client = createLspClient(child);

    let initTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(new Error("LSP initialize timed out")), INIT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.initialize(root), timeoutPromise]);
      clearTimeout(initTimer!);
    } catch (err) {
      clearTimeout(initTimer!);
      log.error(`${config.id}:${root}`, `failed to initialize: ${errText(err)}`);
      await killProcess(child);
      client.shutdown().catch(() => {});
      failedRoots.add(serverKey);
      return null;
    }

    const now = Date.now();
    const server: ManagedServer = {
      config,
      serverKey,
      root,
      process: child,
      client,
      openDocuments: new Map(),
      idleTimer: null,
      args: [...config.args],
      cdbDir: resolution.dir,
      cdbFile: resolution.chosen?.file ?? null,
      startTime: now,
      lastActivity: now,
      editQueue: Promise.resolve({ status: "ok", diagnostics: [], otherFiles: [], retryAttempts: 0 }),
    };

    child.on("exit", () => {
      if (server.idleTimer) clearTimeout(server.idleTimer);
      if (servers.get(serverKey) === server) {
        servers.delete(serverKey);
      }
      if (servers.size === 0) stopSweepTimer();
    });

    resetIdleTimer(server);
    servers.set(serverKey, server);
    startSweepTimer();
    return server;
  }

  // Only the database *directory* is baked into argv, so it is the only part of
  // the lookup that can need a new process. Content changes inside the file are
  // clangd's own problem: it re-reads it about every 5 seconds.
  async function resolveCompileCommands(
    config: LanguageServerConfig,
    root: string,
    filePath: string,
    cwd: string,
    options: { force?: boolean; announce?: boolean } = {},
  ): Promise<AppliedCdb> {
    // Intentionally before any filesystem work: the user either turned discovery
    // off or already pinned a database, and in both cases their word wins.
    const reason = !isDiscoveryEnabled(config)
      ? "disabled" as const
      : hasExplicitCompileCommandsArg(config.args)
        ? "user-pinned" as const
        : null;
    if (reason) {
      return { config, resolution: { dir: null, reason, root: null, candidates: [], outsideRoot: [] } };
    }

    const key = `${config.id}|${root}|${cwd}|${filePath}`;
    const cached = !options.force && cdbCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { config: withCompileCommandsArg(config, cached.resolution.dir), resolution: cached.resolution };
    }

    // Search from the file's own directory upward, like clangd does. The
    // workspace root comes from rootPatterns and may well be a subproject.
    const applied = await applyCompileCommandsDiscovery(config, ancestorsUpTo(filePath, cwd), filePath);
    if (cdbCache.size >= MAX_CDB_CACHE_ENTRIES) cdbCache.clear();
    cdbCache.set(key, { resolution: applied.resolution, expiresAt: Date.now() + CDB_REVALIDATE_MS });
    if (options.announce !== false) announceCdb(config.id, root, applied.resolution);
    return applied;
  }

  // Notices worth reading are worth reading once. Repeating them on every edit
  // would drown the log.
  function announceOnce(id: string, key: string, message: string): void {
    const fullKey = `${id}|${key}`;
    if (cdbAnnounced.has(fullKey)) return;
    cdbAnnounced.add(fullKey);
    log.info(id, message);
  }

  function announceCdb(id: string, root: string, resolution: CdbResolution): void {
    const message = describeResolution(resolution, root);
    if (!message) return;
    announceOnce(id, `cdb|${root}|${resolution.reason}|${resolution.dir ?? ""}`, message);
  }

  async function databaseFileExists(file: string): Promise<boolean> {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Whether a running clangd must be replaced. The choice is sticky: clangd takes
   * exactly one --compile-commands-dir, so two files in one workspace that resolve
   * to different databases must not fight over it or the server would restart on
   * every alternating edit.
   *
   * A replacement happens in two cases only: the workspace gained a database that
   * clangd cannot see, or the one in use has disappeared (clean build, switched
   * generator, or the user pinned a location in .clangd).
   */
  async function decideReplacement(
    existing: ManagedServer,
    config: LanguageServerConfig,
    root: string,
    filePath: string,
    cwd: string,
  ): Promise<AppliedCdb | null> {
    if (!existing.cdbDir) {
      const applied = await resolveCompileCommands(config, root, filePath, cwd);
      return applied.resolution.dir ? applied : null;
    }

    if (existing.cdbFile && (await databaseFileExists(existing.cdbFile))) {
      const applied = await resolveCompileCommands(config, root, filePath, cwd, { announce: false });
      if (applied.resolution.dir && applied.resolution.dir !== existing.cdbDir) {
        announceOnce(
          config.id,
          `cdb-rival|${root}|${existing.cdbDir}|${applied.resolution.dir}`,
          [
            `workspace has more than one compilation database. clangd is using`,
            `  ${existing.cdbDir}`,
            `but this file resolves to`,
            `  ${applied.resolution.dir}`,
            `the running choice is kept; pin one with "cdbGlobs" to change it.`,
          ].join("\n  "),
        );
      }
      return null;
    }

    // The database we point at is gone: look again, and accept whatever answer
    // comes back, including "none" (clangd then falls back on its own search).
    return await resolveCompileCommands(config, root, filePath, cwd, { force: true });
  }

  function allowRestart(serverKey: string): boolean {
    const last = cdbRestarts.get(serverKey) ?? 0;
    if (Date.now() - last < CDB_RESTART_COOLDOWN_MS) return false;
    cdbRestarts.set(serverKey, Date.now());
    return true;
  }

  function spawnOnce(
    config: LanguageServerConfig,
    root: string,
    serverKey: string,
    resolution: CdbResolution,
  ): Promise<ManagedServer | null> {
    if (disabledBinaries.has(config.id)) return Promise.resolve(null);
    if (failedRoots.has(serverKey)) return Promise.resolve(null);

    const promise = spawnServer(config, root, serverKey, resolution).finally(() => pending.delete(serverKey));
    pending.set(serverKey, promise);
    return promise;
  }

  async function ensureServer(
    config: LanguageServerConfig,
    root: string,
    filePath: string,
    cwd: string,
  ): Promise<ManagedServer | null> {
    const serverKey = `${config.id}:${root}`;

    // Never restart on top of a spawn that is still initializing.
    const inflight = pending.get(serverKey);
    if (inflight) return inflight;

    const existing = servers.get(serverKey);
    if (existing) {
      const replacement = await decideReplacement(existing, config, root, filePath, cwd);
      if (!replacement) return existing;

      const change = `${existing.cdbDir ?? "none"} -> ${replacement.resolution.dir ?? "none"}`;
      if (!allowRestart(serverKey)) {
        announceOnce(config.id, `cdb-throttled|${serverKey}`, `compilation database changed (${change}); restart suppressed, run /lsp-restart to force it`);
        return existing;
      }
      log.info(config.id, `compilation database changed (${change}), restarting`);
      await shutdownServer(existing);
      return spawnOnce(replacement.config, root, serverKey, replacement.resolution);
    }

    const applied = await resolveCompileCommands(config, root, filePath, cwd);
    return spawnOnce(applied.config, root, serverKey, applied.resolution);
  }

  function getMaxRetries(config: LanguageServerConfig): number {
    const raw = config.maxRetries ?? defaultMaxRetries;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return defaultMaxRetries;
    return Math.max(0, Math.min(10, Math.floor(raw)));
  }

  /** mtime and size of a file, or null when it is no longer on disk. */
  async function diskStamp(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const info = await stat(filePath);
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  }

  /**
   * Stop trusting documents the disk changed under. Anything can rewrite a file between our
   * edits — `git checkout`, `sed -i`, a formatter run — and until the server hears about it it
   * keeps parsing the text we sent: line numbers drift, and diagnostics that no longer exist keep
   * coming back. The fix is the disk text, pushed as a change, so the file stays under observation.
   *
   * The file being edited is skipped: its current text is sent a few lines later anyway.
   */
  async function syncExternallyChangedDocuments(server: ManagedServer, editedUri: string): Promise<void> {
    const resynced: string[] = [];
    const closed: string[] = [];

    for (const [uri, doc] of server.openDocuments) {
      if (uri === editedUri) continue;
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        continue; // not a local path we can judge
      }

      const stamp = await diskStamp(filePath);
      if (stamp === null) {
        closed.push(uri);
        continue;
      }
      if (stamp.mtimeMs === doc.mtimeMs && stamp.size === doc.size) continue;

      let text: string;
      try {
        text = await readFile(filePath, "utf-8");
      } catch {
        continue; // changed, then unreadable — leave it alone and try again next time
      }
      const hash = hashText(text);
      if (hash === doc.textHash) {
        // Rewritten with the same content: a checkout of the same commit, a formatter that found
        // nothing to change. Only the stamp is stale; the server still holds the right text.
        server.openDocuments.set(uri, { ...doc, mtimeMs: stamp.mtimeMs, size: stamp.size });
        continue;
      }

      server.client.didChange(uri, text);
      server.openDocuments.set(uri, { lastActivity: Date.now(), ...stamp, textHash: hash });
      resynced.push(uri);
    }

    for (const uri of closed) {
      // The file is gone, so its last measurement describes nothing: drop it along with the document.
      server.client.forget(uri);
      server.client.didClose(uri);
      server.openDocuments.delete(uri);
    }

    if (resynced.length > 0) {
      log.info(
        server.config.id,
        `re-sent ${resynced.length} document${resynced.length === 1 ? "" : "s"} rewritten outside the editor`,
      );
    }
    if (closed.length > 0) {
      log.info(server.config.id, `closed ${closed.length} document${closed.length === 1 ? "" : "s"} deleted outside the editor`);
    }
  }

  async function doEdit(server: ManagedServer, filePath: string): Promise<DiagnosticResult> {
    resetIdleTimer(server);

    const uri = fileUri(filePath);
    const content = await readFile(filePath, "utf-8");
    const textHash = hashText(content);
    const stamp = (await diskStamp(filePath)) ?? { mtimeMs: 0, size: content.length };
    const timeout = perServerTimeout.get(server.config.id) ?? server.config.diagnosticTimeout ?? diagnosticTimeout;
    const retries = getMaxRetries(server.config);

    await syncExternallyChangedDocuments(server, uri);
    const held = server.openDocuments.get(uri);

    // The server already holds this exact text. Sending it again would wipe our cached answer, and a
    // server with nothing new to say sends nothing — the wait would end in a timeout and the file
    // would be reported as clean. An agent re-writing a file it just wrote hits this every time.
    if (held && held.textHash === textHash) {
      server.openDocuments.set(uri, { lastActivity: Date.now(), ...stamp, textHash });
      return await server.client.waitForDiagnostics(uri, UNCHANGED_TEXT_WAIT_MS);
    }

    if (held) {
      server.client.didChange(uri, content);
    } else {
      server.client.didOpen(uri, languageIdForFile(filePath, server.config), content);
    }
    server.openDocuments.set(uri, { lastActivity: Date.now(), ...stamp, textHash });

    let lastResult = await server.client.waitForDiagnostics(uri, timeout);

    for (let attempt = 0; attempt < retries && lastResult.status === "timeout"; attempt++) {
      resetIdleTimer(server);
      const baseDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      const jitter = baseDelay * Math.random() * 0.5;
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));

      server.client.didChange(uri, content);
      server.openDocuments.set(uri, { lastActivity: Date.now(), ...stamp, textHash });
      const result = await server.client.waitForDiagnostics(uri, timeout);
      result.retryAttempts = attempt + 1;

      if (result.status === "ok") {
        return result;
      }
      lastResult = result;
    }

    return lastResult;
  }

  return {
    async handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult> {
      const root = await findWorkspaceRoot(filePath, config.rootPatterns, cwd);
      const server = await ensureServer(config, root, filePath, cwd);
      if (!server) return { status: "unavailable" as const, diagnostics: [], otherFiles: [], retryAttempts: 0 };

      // serialize edits per server to avoid concurrent waitForDiagnostics races
      const result = server.editQueue.then(
        () => doEdit(server, filePath),
        () => doEdit(server, filePath),
      );
      server.editQueue = result;
      return result;
    },

    getAllDiagnostics(): Map<string, FileFindings> {
      const result = new Map<string, FileFindings>();
      for (const server of servers.values()) {
        if (!server.client) continue;
        for (const [uri, diags] of server.client.getAllDiagnostics()) {
          result.set(uri, { diagnostics: [...diags], watched: server.openDocuments.has(uri) });
        }
      }
      return result;
    },

    measuredDocuments(): number {
      let count = 0;
      for (const server of servers.values()) {
        if (!server.client) continue;
        count += server.client.measuredDocuments().length;
      }
      return count;
    },

    status(): ServerStatus[] {
      return Array.from(servers.values()).map((s) => ({
        id: s.config.id,
        root: s.root,
        pid: s.process.pid ?? 0,
        uptime: Date.now() - s.startTime,
        openDocuments: s.openDocuments.size,
        lastActivity: s.lastActivity,
        args: [...s.args],
      }));
    },

    diagnosticSummary(): DiagnosticSummary {
      let errors = 0;
      let warnings = 0;
      let files = 0;
      for (const server of servers.values()) {
        for (const diags of server.client.getAllDiagnostics().values()) {
          let fileErrors = 0;
          let fileWarnings = 0;
          for (const d of diags) {
            if (d.severity === DiagnosticSeverity.Error) fileErrors++;
            else if (d.severity === DiagnosticSeverity.Warning) fileWarnings++;
          }
          if (fileErrors + fileWarnings > 0) files++;
          errors += fileErrors;
          warnings += fileWarnings;
        }
      }
      const dead = new Set(disabledBinaries);
      for (const key of failedRoots) dead.add(key.slice(0, key.indexOf(":")));

      return { errors, warnings, files, unavailable: [...dead].sort() };
    },

    async restart(id?: string): Promise<number> {
      const targets = [...servers.values()].filter((s) => !id || s.config.id === id);

      // Restarting means "re-read the filesystem", so drop what we learned about
      // this server: cached database lookups, one-shot notices, and the
      // initialize failures that would otherwise blacklist the workspace.
      for (const key of [...cdbCache.keys()]) {
        if (!id || key.startsWith(id + "|")) cdbCache.delete(key);
      }
      for (const key of [...cdbAnnounced]) {
        if (!id || key.startsWith(id + "|")) cdbAnnounced.delete(key);
      }
      for (const key of [...failedRoots]) {
        if (!id || key.startsWith(id + ":")) failedRoots.delete(key);
      }
      // A binary installed by hand since the last attempt is also the filesystem changing, so
      // the PATH blacklist goes the same way. Keeping it would hold the footer on "server
      // unavailable" for a server that is now healthy.
      for (const key of [...disabledBinaries]) {
        if (!id || key === id) disabledBinaries.delete(key);
      }

      await Promise.allSettled(targets.map((s) => shutdownServer(s)));
      return targets.length;
    },

    async shutdownAll() {
      stopSweepTimer();
      const shutdowns = Array.from(servers.values()).map((s) => shutdownServer(s));
      await Promise.allSettled(shutdowns);
    },
  };
}
