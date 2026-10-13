/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps) with node:crypto only, so the contract tests
 * can act as an authenticator app. Independent of the server's implementation on purpose:
 * agreement between the two is part of what is being tested.
 */
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (what authenticator apps and `TwoFactorSetup.secret` use). */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 character ${JSON.stringify(ch)}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for an 8-byte big-endian counter. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP code for a base32 secret at unix time `unixSeconds` (default: now). */
export function totp(secretBase32: string, unixSeconds = Date.now() / 1000, stepSeconds = 30): string {
  return hotp(base32Decode(secretBase32), Math.floor(unixSeconds / stepSeconds));
}
