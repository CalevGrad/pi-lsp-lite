import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  ShutdownRequest,
  ExitNotification,
  PublishDiagnosticsNotification,
  DiagnosticSeverity,
  type InitializeParams,
  type Diagnostic,
} from "vscode-languageserver-protocol/node";
import type { ChildProcess } from "node:child_process";
import { fileUri } from "./util.js";

export interface OtherFileDiagnostics {
  uri: string;
  errorCount: number;
  warningCount: number;
  firstDiagnostic?: { severity: number; line: number; col: number; message: string; source?: string };
}

export interface DiagnosticResult {
  status: "ok" | "timeout" | "unavailable";
  diagnostics: Diagnostic[];
  otherFiles: OtherFileDiagnostics[];
}

export interface LspClient {
  initialize(workspaceRoot: string): Promise<void>;
  didOpen(uri: string, languageId: string, content: string): void;
  didChange(uri: string, content: string): void;
  didClose(uri: string): void;
  /**
   * Drop the last measurement for a URI entirely. Used when the file itself is gone, so the
   * numbers describe nothing; closing a document that still exists keeps the measurement.
   */
  forget(uri: string): void;
  /** URIs this client has received a publishDiagnostics for and has not since re-sent. */
  measuredDocuments(): string[];
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult>;
  getAllDiagnostics(): Map<string, Diagnostic[]>;
  shutdown(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const QUIESCENCE_MS = 200;
/**
 * How many closed documents keep their last measurement before the oldest is dropped. Far above the
 * open-document limit on purpose: closing a document to stay within that limit must not remove a
 * file from the report.
 */
const MAX_RETAINED_CLOSED_MEASUREMENTS = 200;

function countDiagnostics(diags: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) errors++;
    else if (d.severity === DiagnosticSeverity.Warning) warnings++;
  }
  return { errors, warnings };
}

/** LSP allows a plain string or markup for a diagnostic message. */
export function diagnosticMessage(d: Diagnostic): string {
  return typeof d.message === "string" ? d.message : d.message.value;
}

function diagnosticFingerprint(d: Diagnostic): string {
  return `${d.severity}:${d.range.start.line}:${d.range.start.character}:${diagnosticMessage(d)}`;
}

function fingerprintSet(diags: Diagnostic[]): Set<string> {
  const set = new Set<string>();
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning) {
      set.add(diagnosticFingerprint(d));
    }
  }
  return set;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

export function createLspClient(child: ChildProcess): LspClient {
  if (!child.stdout || !child.stdin) {
    throw new Error("LSP child process must be spawned with stdio: pipe");
  }

  const connection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  interface DiagnosticEntry {
    diagnostics: Diagnostic[];
    generation: number;
    received: boolean;
    resolve?: () => void;
  }

  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  const documentVersion = new Map<string, number>();
  const uriGeneration = new Map<string, number>();
  /**
   * URIs whose document was closed while their measurement was kept, oldest first. Bounds the
   * retained set: a long session that touched thousands of files should not accumulate forever.
   */
  const retainedClosed = new Map<string, number>();
  let closeSequence = 0;

  const retainClosedMeasurement = (uri: string) => {
    retainedClosed.delete(uri);
    retainedClosed.set(uri, ++closeSequence);
    while (retainedClosed.size > MAX_RETAINED_CLOSED_MEASUREMENTS) {
      const oldest = retainedClosed.keys().next().value as string;
      retainedClosed.delete(oldest);
      diagnosticsMap.delete(oldest);
      documentVersion.delete(oldest);
      uriGeneration.delete(oldest);
    }
  };
  let crossFileCallback: ((changedUri: string) => void) | null = null;

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const entry = diagnosticsMap.get(params.uri);
    if (entry) {
      const currentGen = uriGeneration.get(params.uri) ?? 0;
      if (entry.generation !== currentGen) return;
      entry.diagnostics = params.diagnostics;
      entry.received = true;
      entry.resolve?.();
    } else {
      const gen = uriGeneration.get(params.uri) ?? 0;
      diagnosticsMap.set(params.uri, { diagnostics: params.diagnostics, generation: gen, received: true });
    }
    if (crossFileCallback) crossFileCallback(params.uri);
  });

  connection.listen();

  return {
    async initialize(workspaceRoot: string) {
      const params: InitializeParams = {
        processId: child.pid ?? null,
        rootUri: fileUri(workspaceRoot),
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
        workspaceFolders: [{ uri: fileUri(workspaceRoot), name: "workspace" }],
      };

      await connection.sendRequest(InitializeRequest.type, params);
      connection.sendNotification(InitializedNotification.type, {});
    },

    didOpen(uri: string, languageId: string, content: string) {
      // No longer a closed document: it must stop competing for the retention cap, or an overflow
      // would evict the findings of a file that is open and being watched.
      retainedClosed.delete(uri);
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, 1);
      diagnosticsMap.set(uri, { diagnostics: [], generation: gen, received: false });
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    },

    didChange(uri: string, content: string) {
      const version = (documentVersion.get(uri) ?? 1) + 1;
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, version);
      diagnosticsMap.set(uri, { diagnostics: [], generation: gen, received: false });
      connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    },

    didClose(uri: string) {
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      // The measurement outlives the document. A file we stopped watching does not become clean,
      // and a report that drops it reads as "nothing wrong here" — which is the opposite of true.
      // The caller's set of open documents is what says "no longer watched", not this map.
      if (diagnosticsMap.has(uri)) retainClosedMeasurement(uri);
      documentVersion.delete(uri);
    },

    forget(uri: string) {
      retainedClosed.delete(uri);
      diagnosticsMap.delete(uri);
      documentVersion.delete(uri);
      uriGeneration.delete(uri);
    },

    measuredDocuments() {
      const uris: string[] = [];
      for (const [uri, entry] of diagnosticsMap) {
        if (entry.received) uris.push(uri);
      }
      return uris;
    },

    async waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult> {
      const targetGen = uriGeneration.get(uri) ?? 0;

      const preSnapshot = new Map<string, Set<string>>();
      for (const [trackedUri, entry] of diagnosticsMap) {
        if (trackedUri !== uri) {
          preSnapshot.set(trackedUri, fingerprintSet(entry.diagnostics));
        }
      }

      const collectOtherFiles = (): OtherFileDiagnostics[] => {
        const result: OtherFileDiagnostics[] = [];
        for (const [trackedUri, entry] of diagnosticsMap) {
          if (trackedUri === uri) continue;
          const postFp = fingerprintSet(entry.diagnostics);
          const preFp = preSnapshot.get(trackedUri) ?? new Set();
          if (setsEqual(postFp, preFp)) continue;
          const post = countDiagnostics(entry.diagnostics);
          const first =
            entry.diagnostics.find((d) => d.severity === DiagnosticSeverity.Error) ??
            entry.diagnostics.find((d) => d.severity === DiagnosticSeverity.Warning);
          result.push({
            uri: trackedUri,
            errorCount: post.errors,
            warningCount: post.warnings,
            ...(first && {
              firstDiagnostic: {
                severity: first.severity ?? DiagnosticSeverity.Error,
                line: first.range.start.line,
                col: first.range.start.character,
                message: diagnosticMessage(first),
                ...(first.source && { source: first.source }),
              },
            }),
          });
        }
        return result;
      };

      return new Promise<DiagnosticResult>((resolve) => {
        let settled = false;
        let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;

        const settle = (status: "ok" | "timeout") => {
          if (settled) return;
          settled = true;
          crossFileCallback = null;
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          resolve({
            status,
            diagnostics: diagnosticsMap.get(uri)?.diagnostics ?? [],
            otherFiles: collectOtherFiles(),
          });
        };

        const resetQuiescence = () => {
          if (settled) return;
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          quiescenceTimer = setTimeout(() => settle("ok"), QUIESCENCE_MS);
        };

        const timeout = setTimeout(() => {
          settle("timeout");
        }, timeoutMs);

        const entry = diagnosticsMap.get(uri) ?? { diagnostics: [], generation: targetGen, received: false };

        entry.resolve = () => {
          clearTimeout(timeout);
          resetQuiescence();
        };
        diagnosticsMap.set(uri, entry);

        // when a non-target URI publishes diagnostics that differ from the
        // pre-snapshot, start quiescence — this catches the case where the
        // edited file is valid but dependents break
        crossFileCallback = (changedUri: string) => {
          if (settled || changedUri === uri) return;
          const preFp = preSnapshot.get(changedUri) ?? new Set<string>();
          const postFp = fingerprintSet(diagnosticsMap.get(changedUri)?.diagnostics ?? []);
          if (!setsEqual(preFp, postFp)) {
            clearTimeout(timeout);
            resetQuiescence();
          }
        };

        if (entry.received) {
          clearTimeout(timeout);
          resetQuiescence();
        }
      });
    },

    getAllDiagnostics(): Map<string, Diagnostic[]> {
      const result = new Map<string, Diagnostic[]>();
      for (const [uri, entry] of diagnosticsMap) {
        if (entry.diagnostics.length > 0) {
          result.set(uri, [...entry.diagnostics]);
        }
      }
      return result;
    },

    async shutdown() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connection.sendRequest(ShutdownRequest.type),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("shutdown timed out")), SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        // timed out or server already exited
      } finally {
        if (timer) clearTimeout(timer);
      }
      connection.dispose();
    },
  };
}
