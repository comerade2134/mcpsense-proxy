import { isIP } from "node:net";

function isPrivateIp(ip: string): boolean {
  if (ip.includes(".")) {
    const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  return false;
}

export function isEgressAllowed(url: string, allowlist: string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  const normalized = host.toLowerCase();
  for (const a of allowlist) {
    const al = a.toLowerCase();
    if (normalized === al || normalized.endsWith("." + al)) return true;
  }
  if (isIP(host.replace(/^\[|\]$/g, ""))) {
    return !isPrivateIp(host);
  }
  // Hostname (not a literal IP): allowed by default. DNS-rebinding protection is
  // explicitly out of scope for this thin slice (documented in README).
  return true;
}
