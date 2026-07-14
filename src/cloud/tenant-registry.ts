import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LegacyClientManager } from "../legacy-client.js";
import { RemoteHttpClientTransport } from "../remote-http-transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DATA_DIR = join(process.cwd(), "data");
const TENANTS_FILE = join(DATA_DIR, "tenants.json");

export interface TenantRecord {
  id: string;
  tokenHash: string;
  kind: "remote" | "stdio";
  remoteUrl?: string;
  command?: string;
  args?: string[];
  endpoint: string;
  paid: boolean;
  createdAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyToken(storedHash: string, token: string): boolean {
  const given = hashToken(token);
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length) return false; // guard: timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

function genId(): string {
  return "t_" + createHash("sha256").update(Math.random().toString() + Date.now()).digest("hex").slice(0, 12);
}

function randomToken(): string {
  return createHash("sha256").update(Math.random().toString() + Date.now()).digest("hex").slice(0, 32);
}

export class TenantRegistry {
  private tenants: TenantRecord[] = [];
  private managers = new Map<string, LegacyClientManager>();

  constructor(private readonly registerKey?: string) {
    this.load();
  }

  private load(): void {
    if (existsSync(TENANTS_FILE)) {
      try {
        this.tenants = JSON.parse(readFileSync(TENANTS_FILE, "utf8")).tenants ?? [];
      } catch {
        this.tenants = [];
      }
    }
  }

  private save(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TENANTS_FILE, JSON.stringify({ tenants: this.tenants }, null, 2));
  }

  async register(
    input: { type: "remote"; url: string } | { type: "stdio"; command: string; args?: string[] },
    providedKey?: string,
  ): Promise<{ record: TenantRecord; token: string }> {
    if (input.type === "stdio" && (!this.registerKey || providedKey !== this.registerKey)) {
      throw new Error("FORBIDDEN_STDIO");
    }
    const id = genId();
    const token = randomToken();
    const record: TenantRecord = {
      id,
      tokenHash: hashToken(token),
      kind: input.type,
      endpoint: `/t/${id}/mcp`,
      paid: false,
      createdAt: Math.floor(Date.now() / 1000),
      ...(input.type === "remote"
        ? { remoteUrl: input.url }
        : { command: input.command, args: input.args ?? [] }),
    };
    this.tenants.push(record);
    this.save();

    // CRITICAL: do NOT create/bootstrap the LegacyClientManager here. Bootstrapping
    // runs the MCP `initialize` handshake (network for remote, spawns a child process
    // for stdio) — that would block registration on backend reachability and break
    // these unit tests (dead port 127.0.0.1:9, `echo` which exits immediately).
    // The manager is created and bootstrapped lazily by ensureManager() on first request.
    return { record, token };
  }

  findById(id: string): TenantRecord | undefined {
    return this.tenants.find((t) => t.id === id);
  }

  getManager(id: string): LegacyClientManager | undefined {
    return this.managers.get(id);
  }

  async ensureManager(id: string): Promise<LegacyClientManager | undefined> {
    const existing = this.managers.get(id);
    if (existing) return existing;
    const rec = this.findById(id);
    if (!rec) return undefined;
    const transport: Transport =
      rec.kind === "remote"
        ? new RemoteHttpClientTransport(rec.remoteUrl!)
        : new StdioClientTransport({ command: rec.command!, args: rec.args ?? [] });
    const manager = new LegacyClientManager(transport);
    await manager.bootstrap();
    this.managers.set(id, manager);
    return manager;
  }

  setPaid(id: string, paid: boolean): void {
    const rec = this.findById(id);
    if (!rec) return;
    rec.paid = paid;
    this.save();
  }

  logPath(id: string): string {
    return join(DATA_DIR, "logs", `${id}.jsonl`);
  }
}
