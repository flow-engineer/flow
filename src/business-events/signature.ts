// Flow-Signature on a business's pushed events: `t=<unix seconds>,v1=<hex HMAC-SHA256>` of
// "t.{t}.{raw body}", with the secret the business was given (whsec_...). t may be at most 5 minutes
// off. Several v1 values are allowed, so a secret can be rotated without dropping events.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a signature's `t` may be from now. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** The hex HMAC for `t` (unix seconds) and the raw body. */
export function eventSignature(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`t.${t}.${body}`).digest("hex");
}

/** The Flow-Signature header for this body, signed now (ms since the epoch). */
export function signEvent(secret: string, body: string, now: number = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${eventSignature(secret, t, body)}`;
}

/** Whether the header signs this body with this secret, at most 5 minutes from `now` (ms). */
export function verifyEventSignature(secret: string, header: string | null | undefined, body: string, now: number = Date.now()): boolean {
  if (!header) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (t === null || !v1.length || Math.abs(now - t * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const want = Buffer.from(eventSignature(secret, t, body), "hex");
  return v1.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
