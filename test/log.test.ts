import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogBuffer, errText, formatLogEntry, log } from "../src/log.js";
import { loadConfig } from "../src/config.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("createLogBuffer", () => {
  it("keeps entries oldest first with level and scope", () => {
    const buffer = createLogBuffer();
    buffer.info("cpp", "first");
    buffer.error("", "second");

    const entries = buffer.entries();
    assert.deepEqual(entries.map((e) => [e.level, e.scope, e.message]), [
      ["info", "cpp", "first"],
      ["error", "", "second"],
    ]);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
    assert.ok(entries[0].time instanceof Date);
  });

  it("drops the oldest entry once capacity is exceeded", () => {
    const buffer = createLogBuffer({ capacity: 3 });
    for (const message of ["a", "b", "c", "d"]) buffer.info("", message);

    assert.deepEqual(buffer.entries().map((e) => e.message), ["b", "c", "d"]);
  });

  it("cuts messages to maxMessageLength and marks the cut", () => {
    const buffer = createLogBuffer({ maxMessageLength: 10 });
    buffer.info("", "x".repeat(50));

    const [entry] = buffer.entries();
    assert.equal(entry.message.length, 10);
    assert.ok(entry.message.endsWith("…"));
  });

  it("returns a copy from entries", () => {
    const buffer = createLogBuffer();
    buffer.info("", "kept");
    buffer.entries().length = 0;

    assert.equal(buffer.entries().length, 1);
  });

  it("clear removes every entry and later entries keep growing the sequence", () => {
    const buffer = createLogBuffer();
    buffer.info("", "before");
    buffer.clear();
    assert.equal(buffer.entries().length, 0);

    buffer.info("", "after");
    assert.equal(buffer.entries()[0].message, "after");
    assert.ok(buffer.entries()[0].seq > 1);
  });
});

describe("formatLogEntry", () => {
  it("renders scope in brackets", () => {
    const line = formatLogEntry({ seq: 1, time: new Date("2026-01-02T03:04:05Z"), level: "warning", scope: "cpp:/repo", message: "boom" });
    // Local time, so only the HH:MM:SS shape and the tail are checked.
    assert.match(line, /^\d{2}:\d{2}:\d{2} warning \[cpp:\/repo\] boom$/);
  });

  it("omits the brackets for an empty scope", () => {
    const line = formatLogEntry({ seq: 1, time: new Date("2026-01-02T03:04:05Z"), level: "info", scope: "", message: "hello" });
    assert.match(line, /^\d{2}:\d{2}:\d{2} info hello$/);
  });
});

describe("errText", () => {
  it("keeps the stack of an Error", () => {
    const text = errText(new Error("bad thing"));
    assert.ok(text.startsWith("Error: bad thing"));
    assert.ok(text.includes("at "));
  });

  it("stringifies non-Error values", () => {
    assert.equal(errText("plain"), "plain");
    assert.equal(errText(undefined), "undefined");
  });
});

describe("shared log", () => {
  it("collects config warnings written by other modules", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), "{ not json");
    log.clear();

    await loadConfig(dir, join(dir, "nonexistent-global.json"));

    const entries = log.entries();
    assert.ok(entries.some((e) => e.level === "error" && e.message.includes("invalid JSON")));
  });
});
