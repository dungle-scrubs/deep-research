import * as dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** SSRF guard: reject non-http(s) schemes, non-standard ports, loopback,
 *  link-local, private, and unspecified ranges, plus .local hosts, before
 *  any request. DNS resolution happens first so a hostname that resolves
 *  into a forbidden range is also refused. */
export interface GuardVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Expand an IPv6 address (including :: and v4-mapped forms) to a BigInt. */
function ipv6ToBig(ip: string): bigint | null {
  let head = ip;
  let tail = "";
  const doubleColon = ip.indexOf("::");
  if (doubleColon >= 0) {
    head = ip.slice(0, doubleColon);
    tail = ip.slice(doubleColon + 2);
  } else if (ip.split(":").length !== 8) {
    return null;
  }
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const expand = (group: string): string[] => {
    if (group.includes(".")) {
      const parts = group.split(".").map(Number);
      const n =
        ((parts[0] ?? 0) << 24) |
        ((parts[1] ?? 0) << 16) |
        ((parts[2] ?? 0) << 8) |
        (parts[3] ?? 0);
      return [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
    }
    return [group];
  };
  const headParts = headGroups.flatMap(expand);
  const tailParts = tailGroups.flatMap(expand);
  const missing = 8 - headParts.length - tailParts.length;
  if (doubleColon < 0 && missing !== 0) return null;
  if (doubleColon >= 0 && missing < 1) return null;
  const groups =
    doubleColon >= 0 ? [...headParts, ...Array(missing).fill("0"), ...tailParts] : headParts;
  let value = 0n;
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    if (Number.isNaN(parsed)) return null;
    value = (value << 16n) | BigInt(parsed);
  }
  return value;
}

const groupsToBig = (...groups: number[]): bigint =>
  groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
const FFFF = 0xffff;
const V6_MAPPED_START = groupsToBig(0, 0, 0, 0, 0, 0xffff, 0, 0);
const V6_MAPPED_END = groupsToBig(0, 0, 0, 0, 0, 0xffff, FFFF, FFFF);
const V6_LOOPBACK = 1n; // ::1
const V6_LINK_LOCAL_START = groupsToBig(0xfe80, 0, 0, 0, 0, 0, 0, 0);
const V6_LINK_LOCAL_END = groupsToBig(0xfebf, FFFF, FFFF, FFFF, FFFF, FFFF, FFFF, FFFF);
const V6_ULA_START = groupsToBig(0xfc00, 0, 0, 0, 0, 0, 0, 0);
const V6_ULA_END = groupsToBig(0xfdff, FFFF, FFFF, FFFF, FFFF, FFFF, FFFF, FFFF);

const v4Blocks = new BlockList();
for (const cidr of [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
]) {
  v4Blocks.addSubnet(cidr.split("/")[0] as string, Number(cidr.split("/")[1]));
}
function ipVerdict(ip: string): GuardVerdict {
  const family = isIP(ip);
  if (family === 4) {
    if (ip === "0.0.0.0") return { allowed: false, reason: `unspecified address ${ip}` };
    if (v4Blocks.check(ip)) {
      return { allowed: false, reason: `refused range containing ${ip}` };
    }
    return { allowed: true };
  }
  if (family === 6) {
    // net.BlockList has no working IPv6 support on this Node line, so the
    // v6 ranges stay numeric.
    const value = ipv6ToBig(ip);
    if (value === null) return { allowed: false, reason: `unparseable address ${ip}` };
    if (value === V6_LOOPBACK) return { allowed: false, reason: `loopback range ${ip}` };
    if (value >= V6_LINK_LOCAL_START && value <= V6_LINK_LOCAL_END)
      return { allowed: false, reason: `link-local range ${ip}` };
    if (value >= V6_ULA_START && value <= V6_ULA_END)
      return { allowed: false, reason: `unique-local range ${ip}` };
    if (value >= V6_MAPPED_START && value <= V6_MAPPED_END) {
      const embedded = value & 0xffff_ffffn;
      const embeddedIp = `${(embedded >> 24n) & 0xffn}.${(embedded >> 16n) & 0xffn}.${(embedded >> 8n) & 0xffn}.${embedded & 0xffn}`;
      return ipVerdict(embeddedIp);
    }
    if (value === 0n) return { allowed: false, reason: `unspecified address ${ip}` };
    return { allowed: true };
  }
  return { allowed: false, reason: `not an IP address: ${ip}` };
}

export async function guardUrl(raw: string): Promise<GuardVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `scheme ${url.protocol} not allowed (http/https only)` };
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { allowed: false, reason: `port ${url.port} not allowed` };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return { allowed: false, reason: `local hostname ${host}` };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { allowed: false, reason: `localhost hostname ${host}` };
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const literal = isIP(bare);
  if (literal !== 0) return ipVerdict(bare);
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0) return { allowed: false, reason: `host ${host} has no addresses` };
    for (const { address } of records) {
      const verdict = ipVerdict(address);
      if (!verdict.allowed) {
        return { allowed: false, reason: `host ${host} resolves to ${verdict.reason}` };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: `DNS lookup failed for ${host}` };
  }
}
