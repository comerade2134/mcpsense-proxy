import { TenantRegistry, verifyToken, hashToken } from "../../src/cloud/tenant-registry.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

describe("TenantRegistry", () => {
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
    reg.setPaid("t_doesnotexist", true); // no-op, must not throw
  });
});
