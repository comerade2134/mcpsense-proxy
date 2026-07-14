import { isIP } from "node:net";

function expandV6(v6: string): number[] | null {
  if (!v6.includes(":")) return null;
  const hasDouble = v6.includes("::");
  let parts = v6.split(":");
  if (hasDouble) {
    const idx = parts.indexOf("");
    const head = parts.slice(0, idx);
    const tail = parts.slice(idx + 1).filter((p) => p !== "");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    parts = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (parts.length !== 8) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    nums.push(Number.parseInt(p, 16));
  }
  return nums;
}

function extractEmbeddedIpv4(v6: string): string | null {
  // IPv4-mapped: ::ffff:a.b.c.d  or  ::ffff:h1:h2
  if (v6.startsWith("::ffff:")) {
    const rest = v6.slice("::ffff:".length);
    if (rest.includes(".")) return rest;
    const parts = rest.split(":");
    const nums = parts.map((p) => Number.parseInt(p, 16));
    if (nums.length >= 2 && nums.every((n) => !Number.isNaN(n))) {
      return `${nums[0] >> 8 & 0xff}.${nums[0] & 0xff}.${nums[1] >> 8 & 0xff}.${nums[1] & 0xff}`;
    }
    return null;
  }
  const nums = expandV6(v6);
  if (!nums) return null;
  // 6to4: 2002::/16 -> embedded IPv4 in bits 16-48 (hextets 1-2)
  if (nums[0] === 0x2002) {
    return `${nums[1] >> 8 & 0xff}.${nums[1] & 0xff}.${nums[2] >> 8 & 0xff}.${nums[2] & 0xff}`;
  }
  // Teredo: 2001:0:/32 -> client IPv4 in bits 96-127 (hextets 6-7), XOR 0xFFFFFFFF
  if (nums[0] === 0x2001 && nums[1] === 0) {
    const v = ((nums[6] << 16) | nums[7]) ^ 0xffffffff;
    return `${(v >> 24) & 0xff}.${(v >> 16) & 0xff}.${(v >> 8) & 0xff}.${v & 0xff}`;
  }
  return null;
}

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
  const embedded = extractEmbeddedIpv4(v6);
  if (embedded) return isPrivateIp(embedded);
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
    // Literal-IP allowlist entries are exact-match only (no wildcard ranges).
    if (isIP(al)) {
      if (normalized === al) return true;
    } else if (normalized === al || normalized.endsWith("." + al)) {
      return true;
    }
  }
  if (isIP(host.replace(/^\[|\]$/g, ""))) {
    return !isPrivateIp(host);
  }
  // Hostname (not a literal IP): allowed by default. DNS-rebinding protection is
  // explicitly out of scope for this thin slice (documented in README).
  return true;
}
