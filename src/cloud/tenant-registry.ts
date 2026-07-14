import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LegacyClientManager } from "../legacy-client.js";
import { RemoteHttpClientTransport } from "../remote-http-transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), "data");
}

export interface TenantRecord {
  id: string;
  tokenHash: string;
  kind: "remote" | "stdio";
  remoteUrl?: string;
  command?: string;
  args?: string[];
  endpoint: string;
  paid: boolean;
  disabled: boolean;
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
  return "t_" + randomBytes(6).toString("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export class TenantRegistry {
  private dataDir: string;
  private tenants: TenantRecord[] = [];
  private managers = new Map<string, LegacyClientManager>();
  private inflight = new Map<string, Promise<LegacyClientManager | undefined>>();

  constructor(private readonly registerKey?: string, dataDir?: string) {
    this.dataDir = resolveDataDir(dataDir);
    this.load();
  }

  private tenantsFile(): string {
    return join(this.dataDir, "tenants.json");
  }

  private load(): void {
    const file = this.tenantsFile();
    if (existsSync(file)) {
      try {
        this.tenants = JSON.parse(readFileSync(file, "utf8")).tenants ?? [];
      } catch {
        this.tenants = [];
      }
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.tenantsFile(), JSON.stringify({ tenants: this.tenants }, null, 2));
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
      disabled: false,
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
    const inFlight = this.inflight.get(id);
    if (inFlight) return inFlight;
    const p = (async () => {
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
    })();
    this.inflight.set(id, p);
    p.finally(() => this.inflight.delete(id));
    return p;
  }

  setPaid(id: string, paid: boolean): void {
    const rec = this.findById(id);
    if (!rec) return;
    rec.paid = paid;
    this.save();
  }

  rotateToken(id: string): string | undefined {
    const rec = this.findById(id);
    if (!rec) return undefined;
    const token = randomToken();
    rec.tokenHash = hashToken(token);
    this.save();
    return token;
  }

  setDisabled(id: string, disabled: boolean): void {
    const rec = this.findById(id);
    if (!rec) return;
    rec.disabled = disabled;
    this.save();
  }

  logPath(id: string): string {
    return join(this.dataDir, "logs", `${id}.jsonl`);
  }
}
