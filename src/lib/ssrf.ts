import { promises as dns } from "node:dns";
import { URL } from "node:url";

export interface SsrfBlockedErrorOptions {
  code: string;
  hostname?: string;
  ip?: string;
}

/**
 * Custom error thrown when a URL is blocked by SSRF protection.
 * Includes the blocking reason code and details about the hostname/IP.
 */
export class SsrfBlockedError extends Error {
  code: string;
  hostname?: string;
  ip?: string;

  constructor(message: string, options: SsrfBlockedErrorOptions) {
    super(message);
    this.name = "SsrfBlockedError";
    this.code = options.code;
    if (options.hostname !== undefined) this.hostname = options.hostname;
    if (options.ip !== undefined) this.ip = options.ip;
  }
}

/**
 * Parse an IPv4 address string into array of octets.
 * Throws if the address is invalid.
 */
function parseIp(ip: string): number[] {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return nums;
}

/**
 * Check if an IPv4 address is within a CIDR range.
 * Example: isIpInRange('192.168.1.5', '192.168.0.0/16') returns true
 */
function isIpInRange(ip: string, cidrRange: string): boolean {
  const parts = cidrRange.split("/");
  const rangeIp = parts[0] ?? "";
  const bitsStr = parts[1] ?? "32";
  const bits = parseInt(bitsStr, 10);

  if (bits < 0 || bits > 32) throw new Error(`Invalid CIDR bits: ${bits}`);

  const ipParts = parseIp(ip);
  const rangeParts = parseIp(rangeIp);

  // Check each full octet
  const fullOctets = Math.floor(bits / 8);
  for (let i = 0; i < fullOctets; i++) {
    if (ipParts[i] !== rangeParts[i]) return false;
  }

  // Check partial octet if needed
  const remainingBits = bits % 8;
  if (remainingBits > 0) {
    const mask = (0xff << (8 - remainingBits)) & 0xff;
    const ipOctet = ipParts[fullOctets] ?? 0;
    const rangeOctet = rangeParts[fullOctets] ?? 0;
    if ((ipOctet & mask) !== (rangeOctet & mask)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if an IP address is in a blocked range (private, loopback, link-local, metadata).
 */
function isIpBlocked(ip: string): string | null {
  // RFC 1918 - Private address ranges
  if (isIpInRange(ip, "10.0.0.0/8")) return "PRIVATE_RFC1918_10";
  if (isIpInRange(ip, "172.16.0.0/12")) return "PRIVATE_RFC1918_172";
  if (isIpInRange(ip, "192.168.0.0/16")) return "PRIVATE_RFC1918_192";

  // Loopback
  if (isIpInRange(ip, "127.0.0.0/8")) return "LOOPBACK";

  // Link-local and metadata (includes 169.254.169.254)
  if (isIpInRange(ip, "169.254.0.0/16")) return "LINK_LOCAL_METADATA";

  return null;
}

/**
 * Assert that a URL is safe from SSRF attacks by:
 * 1. Parsing the URL to extract hostname
 * 2. Resolving the hostname via DNS
 * 3. Checking if resolved IP is in blocked ranges (RFC 1918, loopback, link-local, metadata)
 *
 * Throws SsrfBlockedError if the URL points to a blocked IP range.
 * Returns the original URL string if it passes validation.
 *
 * @param urlString - The URL to validate
 * @returns The original URL string if safe
 * @throws SsrfBlockedError if the resolved IP is in a blocked range
 * @throws Error if URL parsing or DNS resolution fails
 */
export async function assertSafeCloneUrl(urlString: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (error) {
    throw new Error(
      `Invalid URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error(`URL has no hostname: ${urlString}`);
  }

  // Resolve hostname to IP addresses
  let addresses: string[];
  try {
    addresses = await dns.resolve4(hostname);
  } catch (error) {
    throw new Error(
      `Failed to resolve hostname '${hostname}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Check if any resolved IP is blocked
  for (const ip of addresses) {
    const blockCode = isIpBlocked(ip);
    if (blockCode) {
      throw new SsrfBlockedError(
        `Hostname '${hostname}' resolves to blocked IP address ${ip}`,
        {
          code: blockCode,
          hostname,
          ip,
        }
      );
    }
  }

  return urlString;
}
