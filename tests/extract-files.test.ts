import { afterEach, describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFiles } from "../src/extract/files";
import { DEFAULT_SETTINGS, isValidAutoCompactionPercentage, loadSettings } from "../src/core/settings";
import type { NormalizedBlock } from "../src/types";

describe("extractFiles", () => {
  it("matches tool names case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "b.ts" } },
      { kind: "tool_call", name: "Write", args: { path: "c.ts" } },
      { kind: "tool_call", name: "MultiEdit", args: { path: "d.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.read].sort()).toEqual(["a.ts", "b.ts"]);
    expect([...r.modified].sort()).toEqual(["c.ts", "d.ts"]);
    expect([...r.created]).toEqual(["c.ts"]);
  });

  it("records modern edit tools as modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "quick_edit", args: { path: "a.ts" } },
      { kind: "tool_call", name: "target_edit", args: { path: "b.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { readFiles: ["x.ts"], modifiedFiles: ["y.ts"], createdFiles: [] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});

describe("settings defaults", () => {
  it("overrides pi core compaction by default", () => {
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
  });

  it("trackCommands is empty (feature off) by default", () => {
    expect(DEFAULT_SETTINGS.trackCommands).toEqual([]);
  });

  it("leaves the percentage threshold unset by default", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty("autoCompactionPercentage");
  });
});

describe("loadSettings coercion", () => {
  // PI_VCC_CONFIG_PATH is settings.ts' existing override — point it at a
  // tmp file so the real ~/.pi/agent/pi-vcc-config.json is never touched.
  const writeConfig = (value: unknown, key = "trackCommands") => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ [key]: value }));
    process.env.PI_VCC_CONFIG_PATH = path;
  };

  afterEach(() => delete process.env.PI_VCC_CONFIG_PATH);

  it("malformed trackCommands values coerce fail-closed to string[]", () => {
    for (const bad of ["ssh", 42, [1, " kubectl ", null, "kubectl"], null, { 0: "ssh" }]) {
      writeConfig(bad);
      const got = loadSettings().trackCommands;
      expect(Array.isArray(got)).toBe(true);
      for (const x of got) expect(typeof x).toBe("string");
    }
    writeConfig(["ssh", "kubectl"]);
    expect(loadSettings().trackCommands).toEqual(["ssh", "kubectl"]);
  });

  it("accepts percentage thresholds from 1 through 100", () => {
    for (const percentage of [1, 60, 60.5, 100]) {
      writeConfig(percentage, "autoCompactionPercentage");
      expect(loadSettings().autoCompactionPercentage).toBe(percentage);
      expect(isValidAutoCompactionPercentage(percentage)).toBe(true);
    }
  });

  it("ignores and clearly warns about invalid percentage thresholds", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    for (const percentage of [0, 101, "60", null]) {
      writeConfig(percentage, "autoCompactionPercentage");
      expect(loadSettings().autoCompactionPercentage).toBeUndefined();
      expect(isValidAutoCompactionPercentage(percentage)).toBe(false);
    }
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("autoCompactionPercentage"));
    warning.mockRestore();
  });
});
