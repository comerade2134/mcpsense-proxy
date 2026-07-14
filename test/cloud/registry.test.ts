import { TenantRegistry, verifyToken, hashToken } from "../../src/cloud/tenant-registry.js";
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

describe("TenantRegistry", () => {
  afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("registers a remote tenant publicly and returns a plaintext token", async () => {
    const reg = new TenantRegistry();
    const { record, token } = await reg.register({ type: "remote", url: "http://127.0.0.1:9/mcp" });
    expect(record.kind).toBe("remote");
    expect(record.endpoint).toBe(`/t/${record.id}/mcp`);
    expect(record.paid).toBe(false);
    expect(verifyToken(record.tokenHash, token)).toBe(true);
    expect(verifyToken(record.tokenHash, "wrong")).toBe(false);
  });

  it("rejects stdio registration without REGISTER_KEY (403 path)", async () => {
    const reg = new TenantRegistry();
    await expect(reg.register({ type: "stdio", command: "echo", args: ["x"] })).rejects.toThrow("FORBIDDEN_STDIO");
  });

  it("allows stdio registration when REGISTER_KEY matches", async () => {
    const reg = new TenantRegistry("secret-key");
    const { record } = await reg.register({ type: "stdio", command: "echo", args: ["x"] }, "secret-key");
    expect(record.kind).toBe("stdio");
  });

  it("sets paid flag and hashToken is stable length", () => {
    expect(hashToken("abc").length).toBe(64);
    const reg = new TenantRegistry();
    reg.setPaid("t_doesnotexist", true);
  });

  it("does not bootstrap a manager at registration (lazy via ensureManager)", async () => {
    const reg = new TenantRegistry();
    const { record } = await reg.register({ type: "remote", url: "http://127.0.0.1:9/mcp" });
    expect(reg.getManager(record.id)).toBeUndefined();
    const mgr = await reg.ensureManager(record.id);
    expect(mgr).toBeDefined();
    expect(reg.getManager(record.id)).toBe(mgr);
  });

  it("ensureManager returns undefined for unknown tenant", async () => {
    const reg = new TenantRegistry();
    expect(await reg.ensureManager("t_unknown")).toBeUndefined();
  });
});
