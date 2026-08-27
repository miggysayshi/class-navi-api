// Fixed-length secret comparison for server authentication seams.
// Hashing both UTF-8 inputs before timingSafeEqual avoids a direct
// candidate-length branch in the final comparison.
import { createHash, timingSafeEqual } from "node:crypto";

export function safeSecretEqual(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  try {
    const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
    const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
  } catch {
    return false;
  }
}
