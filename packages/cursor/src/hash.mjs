// A SHA-256 as hex: what a token or an API key is kept under, so the secret itself is never a map's key.
import { createHash } from "node:crypto"

export const hashOf = (secret) => createHash("sha256").update(secret).digest("hex")
