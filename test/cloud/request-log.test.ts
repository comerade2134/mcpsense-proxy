import { afterAll, describe, expect, it } from "vitest";
import { appendLog } from "../../src/cloud/request-log.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("request-log", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpsense-log-"));
  const p = join(dir, "t_x.jsonl");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("appends JSONL entries and caps at 1000 lines", () => {
    for (let i = 0; i < 1005; i++) appendLog(p, { n: i });
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1000);
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(1004);
    expect(JSON.parse(lines[0]).n).toBe(5);
  });
});
