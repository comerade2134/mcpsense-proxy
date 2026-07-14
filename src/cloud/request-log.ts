import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CAP = 1000;

export function appendLog(logPath: string, entry: object): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
  cap(logPath);
}

function cap(p: string): void {
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length > CAP) {
    writeFileSync(p, lines.slice(-CAP).join("\n") + "\n");
  }
}
