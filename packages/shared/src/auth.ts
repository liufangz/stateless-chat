import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "chat_auth";
export const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Stateless token: base64url(expiry) + "." + HMAC-SHA256 signature, keyed by AUTH_SECRET. */
export function createAuthToken(
  secret: string,
  ttlMs: number = AUTH_COOKIE_MAX_AGE_MS
): string {
  const payload = Buffer.from(String(Date.now() + ttlMs)).toString(
    "base64url"
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAuthToken(
  token: string | undefined,
  secret: string
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  const expectedSignature = sign(payload, secret);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  // Length must match before timingSafeEqual (it throws on mismatched
  // lengths), but comparing here does not itself introduce a meaningful
  // timing side-channel since signature length is not secret.
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(provided, expected)) return false;

  const expiry = Number(Buffer.from(payload, "base64url").toString());
  if (!Number.isFinite(expiry)) return false;
  return Date.now() < expiry;
}
