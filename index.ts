import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServerManager } from "./src/server-manager.js";
import { languageForFile, checkExtensionOverlaps, builtinLanguages, type LanguageServerConfig } from "./src/languages.js";
import { formatDiagnosticsCompact, formatStatusLine } from "./src/format.js";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { loadConfig, writeGlobalConfig, readGlobalConfig, DEFAULT_UI_MODE, type UiChannel } from "./src/config.js";
import { fileUri, which, isInsideCwd } from "./src/util.js";
import { installRegistry, installCommandFor } from "./src/install-registry.js";
import { buildServerStates, formatServerStates } from "./src/status.js";
import { logLine, recentLogLines } from "./src/log.js";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
  let servers: LanguageServerConfig[] = [];
  let uiChannels: UiChannel[] = [...DEFAULT_UI_MODE];
  const reportedErrors = new Set<string>();
  let manager = createServerManager({});
  const STATUS_KEY = "lsp";
  const WIDGET_KEY = "lsp-diagnostics";

  async function initConfig(cwd: string) {
    await manager.shutdownAll();
    const resolved = await loadConfig(cwd);
    servers = resolved.servers;
    uiChannels = resolved.ui;
    manager = createServerManager({
      diagnosticTimeout: resolved.diagnosticTimeout,
      documentIdleTimeout: resolved.documentIdleTimeout,
      perServerTimeout: resolved.perServerTimeout,
    });

    for (const warning of checkExtensionOverlaps(servers)) {
      logLine(`[pi-lsp-lite] ${warning}`);
    }
  }

  async function currentServerStates() {
    return buildServerStates({
      builtins: builtinLanguages,
      active: servers,
      globalConfig: await readGlobalConfig(),
      running: manager.status(),
      installRegistry,
      resolveCommand: which,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await initConfig(ctx.cwd);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = event.input?.path;
    const filePath = typeof rawPath === "string" ? rawPath : undefined;
    if (!filePath) return;
    if (event.isError) return;

    let absolutePath: string;
    try {
      absolutePath = await realpath(resolve(ctx.cwd, filePath));
    } catch {
      return;
    }
    if (!isInsideCwd(absolutePath, ctx.cwd)) return;
    const langConfig = languageForFile(absolutePath, servers);
    if (!langConfig) return;

    try {
      const result = await manager.handleEdit(absolutePath, langConfig, ctx.cwd);
      const status = formatStatusLine(filePath, result, ctx.cwd);
      const block = formatDiagnosticsCompact(filePath, result, ctx.cwd);

      // Local patch (pi-lsp-lite UI): каналы вывода настраиваются полем `ui`.
      // notify() пишет в transcript и без планки в 10 строк уводил строку ввода и
      // футер за край экрана.
      const widgetLines = block ? block.trim().split("\n") : undefined;
      ctx.ui.setWidget(WIDGET_KEY, uiChannels.includes("widget") ? widgetLines : undefined);
      ctx.ui.setStatus(STATUS_KEY, uiChannels.includes("status") ? ctx.ui.theme.fg(status.level, status.text) : undefined);
      if (uiChannels.includes("chat") && block) ctx.ui.notify(block.trim(), "warning");
      if (!block) return;

      return {
        content: [...event.content, { type: "text" as const, text: block }],
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      logLine(`[pi-lsp-lite] diagnostics failed for ${filePath}: ${err instanceof Error ? err.stack ?? text : text}`);
      // Один текст — одно уведомление, иначе падающий сервер забьёт экран.
      if (!reportedErrors.has(text)) {
        reportedErrors.add(text);
        ctx.ui.notify(`pi-lsp-lite: ${text} — /lsp-log`, "error");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  pi.registerCommand("lsp-status", {
    description: "Show configured LSP servers, install state, and running processes",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatServerStates(await currentServerStates()), "info");
    },
  });

  pi.registerCommand("lsp-diag", {
    description: "Show current LSP diagnostics for all tracked files (or a specific file)",
    handler: async (args, ctx) => {
      const allDiags = manager.getAllDiagnostics();

      if (allDiags.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no diagnostics", "info");
        return;
      }

      const filterPath = args?.trim();
      let filterUri: string | undefined;
      if (filterPath) {
        const abs = resolve(ctx.cwd, filterPath);
        filterUri = fileUri(abs);
      }

      const lines: string[] = [];
      for (const [uri, diags] of allDiags) {
        if (filterUri && uri !== filterUri) continue;
        const filePath = fileURLToPath(new URL(uri));
        const relevant = diags.filter((d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning);
        if (relevant.length === 0) continue;
        lines.push(`${filePath} (${relevant.length} diagnostic${relevant.length !== 1 ? "s" : ""})`);
        for (const d of relevant) {
          const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
          const line = d.range.start.line + 1;
          const col = d.range.start.character + 1;
          const source = d.source ? `[${d.source}] ` : "";
          lines.push(`  ${severity} ${line}:${col} ${source}${d.message}`);
        }
      }

      if (lines.length === 0) {
        ctx.ui.notify(filterPath ? `pi-lsp-lite: no diagnostics for ${filterPath}` : "pi-lsp-lite: no diagnostics", "info");
        return;
      }

      ctx.ui.notify(lines.join("\n"), "warning");
    },
  });

  pi.registerCommand("lsp-log", {
    description: "Show recent extension log lines (language server output, config warnings)",
    handler: async (args, ctx) => {
      const parsed = Number.parseInt(args?.trim() ?? "", 10);
      const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : 20;
      const lines = recentLogLines(limit);
      if (lines.length === 0) {
        ctx.ui.notify("pi-lsp-lite: log is empty (set PI_LSP_DEBUG=1 to mirror it to stderr)", "info");
        return;
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lsp-add", {
    description: "Add a new language server to global config",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-add requires interactive mode", "error");
        return;
      }

      const rawId = await ctx.ui.input("Server ID (e.g. haskell):");
      if (!rawId) return;
      const id = rawId.trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(id)) {
        ctx.ui.notify("pi-lsp-lite: server ID must be lowercase alphanumeric, hyphens, or underscores", "error");
        return;
      }
      const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
      if (RESERVED_IDS.has(id)) {
        ctx.ui.notify("pi-lsp-lite: reserved ID, choose a different name", "error");
        return;
      }

      const rawCommand = await ctx.ui.input("Binary command (e.g. haskell-language-server-wrapper):");
      const command = rawCommand?.trim();
      if (!command) return;

      const argsRaw = await ctx.ui.input("CLI args (comma-separated, or empty):");
      const args = argsRaw ? argsRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];

      const extRaw = await ctx.ui.input("File extensions (comma-separated, e.g. .hs,.lhs):");
      if (!extRaw) return;
      const extensions = extRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (extensions.length === 0) {
        ctx.ui.notify("pi-lsp-lite: at least one extension is required", "error");
        return;
      }

      const rootRaw = await ctx.ui.input("Root pattern files (comma-separated, or empty):");
      const rootPatterns = rootRaw ? rootRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

      const resolved = await which(command);
      await writeGlobalConfig({ servers: { [id]: { command, args, extensions, rootPatterns } } });
      await initConfig(ctx.cwd);

      if (!resolved) {
        ctx.ui.notify(`pi-lsp-lite: configured server "${id}", but "${command}" is missing from PATH — install it manually before use`, "warning");
        return;
      }
      ctx.ui.notify(`pi-lsp-lite: configured server "${id}" (${resolved})`, "info");
    },
  });

  pi.registerCommand("lsp-remove", {
    description: "Disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-remove requires interactive mode", "error");
        return;
      }

      if (servers.length === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const ids = servers.map((s) => s.id);
      const selected = await ctx.ui.select("Disable which server?", ids);
      if (!selected) return;

      const confirmed = await ctx.ui.confirm("Confirm disable", `Disable server "${selected}"?`);
      if (!confirmed) return;

      await writeGlobalConfig({ servers: { [selected]: { disabled: true } } });
      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: disabled server "${selected}"`, "info");
    },
  });

  pi.registerCommand("lsp-toggle", {
    description: "Enable or disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-toggle requires interactive mode", "error");
        return;
      }

      const builtinIds = new Set(builtinLanguages.map((l) => l.id));
      const activeIds = new Set(servers.map((s) => s.id));

      // include disabled user-added servers from global config so they can be re-enabled
      const globalConfig = await readGlobalConfig();
      const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
      const globalServerIds = (globalConfig?.servers && typeof globalConfig.servers === "object" && !Array.isArray(globalConfig.servers))
        ? Object.keys(globalConfig.servers).filter((k) => !RESERVED.has(k))
        : [];
      const allIds = new Set<string>([...builtinIds, ...activeIds, ...globalServerIds]);

      if (allIds.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const entries = [...allIds];
      const options = entries.map((id) => `${id} ${activeIds.has(id) ? "[enabled]" : "[disabled]"}`);
      const choice = await ctx.ui.select("Toggle which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const id = entries[idx];
      const isCurrentlyEnabled = activeIds.has(id);

      if (isCurrentlyEnabled) {
        await writeGlobalConfig({ servers: { [id]: { disabled: true } } });
      } else {
        // re-enable: works for both built-ins and user-added servers in global config
        await writeGlobalConfig({ servers: { [id]: { disabled: false } } });
      }

      await initConfig(ctx.cwd);

      if (isCurrentlyEnabled) {
        ctx.ui.notify(`pi-lsp-lite: disabled server "${id}"`, "info");
        return;
      }

      const state = (await currentServerStates()).find((s) => s.id === id);
      if (state?.installed === false) {
        const installHint = state.installable ? "run /lsp-install" : "install it manually";
        ctx.ui.notify(`pi-lsp-lite: enabled server "${id}", but "${state.command}" is missing from PATH — ${installHint} before use`, "warning");
        return;
      }
      if (state?.installed === null) {
        ctx.ui.notify(`pi-lsp-lite: enabled server "${id}", but its command is incomplete — check global config`, "warning");
        return;
      }
      ctx.ui.notify(`pi-lsp-lite: enabled server "${id}"`, "info");
    },
  });

  pi.registerCommand("lsp-install", {
    description: "Install a missing language server binary",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-install requires interactive mode", "error");
        return;
      }

      const checks = await Promise.all(
        [...installRegistry].map(async ([id, entry]) => {
          const lang = builtinLanguages.find((l) => l.id === id);
          const binary = lang?.command ?? id;
          const found = await which(binary);
          return found ? null : { id, command: binary, installCmd: installCommandFor(entry), description: entry.description };
        }),
      );
      const missing = checks.filter((c): c is NonNullable<typeof c> => c !== null);

      if (missing.length === 0) {
        ctx.ui.notify("pi-lsp-lite: all built-in installable servers are available; custom servers must be installed manually", "info");
        return;
      }

      const options = missing.map((m) => `${m.id} — ${m.description} (${m.command})`);
      const choice = await ctx.ui.select("Install which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const selected = missing[idx];

      const confirmed = await ctx.ui.confirm("Confirm install", `Run: ${selected.installCmd}`);
      if (!confirmed) return;

      const result = process.platform === "win32"
        ? await pi.exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", selected.installCmd])
        : await pi.exec("sh", ["-c", selected.installCmd]);
      if (result.code !== 0) {
        ctx.ui.notify(`pi-lsp-lite: install failed (exit ${result.code})\n${result.stderr}`, "error");
        return;
      }

      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: installed ${selected.id}`, "info");
    },
  });
}
