/**
 * Password hashing scheme used by Class-Navi (verified from the JS bundle,
 * `passwordToB64Hash(e, n)` — called with `(password, salt)`):
 *   base64( sha256( HEX_UPPER(sha256(salt)) + password ) )
 * The salt is hashed first, hex-encoded UPPERCASE (`ue.toHexString` calls
 * `.toUpperCase()`), concatenated with the UTF-8 password, hashed again,
 * base64-encoded. Salt = systemCountryCD + loginID (e.g. "USA00970532").
 */

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // buffer is a fresh ArrayBuffer (created by TextEncoder/crypto) — safe cast
  return crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer).then((d) => new Uint8Array(d));
}

function toHexUpper(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const inner = await sha256(enc.encode(salt));
  const outer = await sha256(enc.encode(toHexUpper(inner) + password));
  return Buffer.from(outer).toString("base64");
}
