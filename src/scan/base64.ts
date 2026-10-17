import type { Finding } from '../types'
import { BASE64_BLOB, PRINTABLE } from './constants'
import { redact } from './redact'

/** Decodes standard or URL-safe base64; throws on anything else. */
export function fromBase64(blob: string): string {
  return atob(blob.replace(/-/g, '+').replace(/_/g, '/'))
}

/** The text a blob encodes, or null when it is not base64 of printable text. */
export function decodeBase64(blob: string): string | null {
  try {
    const decoded = fromBase64(blob.replace(/=+$/, ''))
    return PRINTABLE.test(decoded) ? decoded : null
  }
  catch {
    return null
  }
}

// A Kubernetes Secret, a `base64 -d` pipeline or a Basic credential carries the
// secret encoded. A blob that decodes to binary (a key body, a hash) is passed
// over; one that decodes to text is scanned like any text, nested encodings
// included, and each level is three quarters the size of the one above. The
// finding spans the encoded text.
export function findEncoded(text: string, scan: (decoded: string) => Finding[]): Finding[] {
  const found: Finding[] = []
  for (const match of text.matchAll(BASE64_BLOB)) {
    const decoded = decodeBase64(match[0])
    const inner = decoded === null ? undefined : scan(decoded)[0]
    if (!decoded || !inner)
      continue
    found.push({
      ...inner,
      name: `${inner.name}, base64-encoded`,
      start: match.index,
      end: match.index + match[0].length,
      preview: redact(decoded.slice(inner.start, inner.end)),
    })
  }
  return found
}
