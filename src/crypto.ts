/**
 * Password hashing scheme used by Class-Navi (verified from the JS bundle):
 *   base64( sha256( sha256(password) + username ) )
 * where sha256(password) is the raw digest bytes concatenated with the UTF-8
 * bytes of the username, hashed again, then base64-encoded.
 */

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // buffer is a fresh ArrayBuffer (created by TextEncoder/crypto) — safe cast
  return crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer).then((d) => new Uint8Array(d));
}

export async function hashPassword(password: string, username: string): Promise<string> {
  const inner = await sha256(enc.encode(password));
  const combined = new Uint8Array(inner.length + username.length);
  combined.set(inner, 0);
  combined.set(enc.encode(username), inner.length);
  const outer = await sha256(combined);
  return Buffer.from(outer).toString("base64");
}
