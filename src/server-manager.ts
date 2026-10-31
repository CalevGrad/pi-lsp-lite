import { type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { which, fileUri, findWorkspaceRoot } from "./util.js";
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
import type { Diagnostic } from "vscode-languageserver-protocol";
import { DEFAULT_DIAGNOSTIC_TIMEOUT, DEFAULT_DOCUMENT_IDLE_TIMEOUT, DEFAULT_MAX_RETRIES } from "./config.js";
import { readFile, stat } from "node:fs/promises";

interface ManagedServer {
  config: LanguageServerConfig;
  serverKey: string;
  root: string;
  process: ChildProcess;
  client: LspClient;
  openDocuments: Map<string, number>;
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

export interface ServerManager {
  handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult>;
  status(): ServerStatus[];
  getAllDiagnostics(): Map<string, Diagnostic[]>;
  /** Stops running servers (all, or only one id) so the next edit respawns them with current config. */
  restart(id?: string): Promise<number>;
  shutdownAll(): Promise<void>;
}

export interface ServerStatus {
  id: string;
  root: string;
  pid: number;
  uptime: number;
  openDocuments: number;
  lastActivity: number;
}

export interface ServerStatus {
  id: string;
  root: string;
  pid: number;
  uptime: number;
  openDocuments: number;
  lastActivity: number;
  args: string[];
}

const IDLE_TIMEOUT_MS = 240_000;
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
  perServerTimeout?: Map<string, number>;
  maxRetries?: number;
}

const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

export function createServerManager(options: ServerManagerOptions = {}): ServerManager {
  const diagnosticTimeout = options.diagnosticTimeout ?? DEFAULT_DIAGNOSTIC_TIMEOUT;
  const documentIdleTimeout = options.documentIdleTimeout ?? DEFAULT_DOCUMENT_IDLE_TIMEOUT;
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
          .filter(([, lastActive]) => now - lastActive > documentIdleTimeout);
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
    server.idleTimer = setTimeout(() => shutdownServer(server), IDLE_TIMEOUT_MS);
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
      console.error(`[pi-lsp-lite:${config.id}] ${config.command} not found on PATH, disabling ${config.id}`);
      disabledBinaries.add(config.id);
      return null;
    }

    const child = spawn(binaryPath, config.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[pi-lsp-lite:${config.id}:${root}]`, chunk.toString().trimEnd());
    });

    child.on("error", (err) => {
      console.error(`[pi-lsp-lite:${config.id}:${root}] process error:`, err);
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
      console.error(`[pi-lsp-lite:${config.id}:${root}] failed to initialize:`, err);
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
    console.error(`[pi-lsp-lite:${id}]`, message);
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
      console.error(`[pi-lsp-lite:${config.id}] compilation database changed (${change}), restarting`);
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

  async function doEdit(server: ManagedServer, filePath: string): Promise<DiagnosticResult> {
    resetIdleTimer(server);

    const uri = fileUri(filePath);
    const content = await readFile(filePath, "utf-8");
    const timeout = perServerTimeout.get(server.config.id) ?? server.config.diagnosticTimeout ?? diagnosticTimeout;
    const retries = getMaxRetries(server.config);

    if (server.openDocuments.has(uri)) {
      server.client.didChange(uri, content);
    } else {
      server.client.didOpen(uri, languageIdForFile(filePath, server.config), content);
    }
    server.openDocuments.set(uri, Date.now());

    let lastResult = await server.client.waitForDiagnostics(uri, timeout);

    for (let attempt = 0; attempt < retries && lastResult.status === "timeout"; attempt++) {
      resetIdleTimer(server);
      const baseDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      const jitter = baseDelay * Math.random() * 0.5;
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));

      server.client.didChange(uri, content);
      server.openDocuments.set(uri, Date.now());
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

    getAllDiagnostics(): Map<string, Diagnostic[]> {
      const result = new Map<string, Diagnostic[]>();
      for (const server of servers.values()) {
        for (const [uri, diags] of server.client.getAllDiagnostics()) {
          result.set(uri, diags);
        }
      }
      return result;
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
