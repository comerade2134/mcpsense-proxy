import { describe, expect, it } from "vitest";
import { isEgressAllowed } from "../../src/cloud/egress.js";

describe("isEgressAllowed", () => {
  it("blocks cloud metadata and private/loopback IPs by default", () => {
    expect(isEgressAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isEgressAllowed("http://127.0.0.1:9/mcp")).toBe(false);
    expect(isEgressAllowed("http://10.0.0.5/mcp")).toBe(false);
    expect(isEgressAllowed("http://192.168.1.1/mcp")).toBe(false);
    expect(isEgressAllowed("http://172.16.0.1/mcp")).toBe(false);
    expect(isEgressAllowed("http://[::1]/mcp")).toBe(false);
  });
  it("allows public hostnames by default", () => {
    expect(isEgressAllowed("https://api.example.com/mcp")).toBe(true);
  });
  it("respects an explicit allowlist (incl. loopback)", () => {
    expect(isEgressAllowed("http://127.0.0.1:9/mcp", ["127.0.0.1"])).toBe(true);
    expect(isEgressAllowed("http://169.254.169.254/x", ["169.254.169.254"])).toBe(true);
  });
  it("rejects non-http(s) and malformed urls", () => {
    expect(isEgressAllowed("file:///etc/passwd")).toBe(false);
    expect(isEgressAllowed("not-a-url")).toBe(false);
  });
  it("blocks embedded IPv4-in-IPv6 transitional addresses", () => {
    expect(isEgressAllowed("http://[::ffff:7f00:1]/mcp")).toBe(false); // 127.0.0.1
    expect(isEgressAllowed("http://[::ffff:a9fe:a9fe]/mcp")).toBe(false); // 169.254.169.254
    expect(isEgressAllowed("http://[2002:0a00:1::]/mcp")).toBe(false); // 10.0.0.1 (6to4)
    expect(isEgressAllowed("http://[2001:0:0:0:0:0:f5ff:fffe]/")).toBe(false); // Teredo -> 10.0.0.1
  });
  it("treats literal-IP allowlist entries as exact-match only (no range suffix)", () => {
    expect(isEgressAllowed("http://127.0.0.1:9/mcp", ["10.0.0.5"])).toBe(false);
    expect(isEgressAllowed("http://10.0.0.6/mcp", ["10.0.0.5"])).toBe(false);
    expect(isEgressAllowed("http://10.0.0.5/mcp", ["10.0.0.5"])).toBe(true);
    expect(isEgressAllowed("http://sub.example.com/mcp", ["example.com"])).toBe(true); // hostname suffix still works
  });
});
