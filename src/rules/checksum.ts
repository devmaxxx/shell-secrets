import { BASE62, CRC_TABLE } from './constants'

function crc32(text: string): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < text.length; i++)
    crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function base62(value: number, width: number): string {
  let out = ''
  for (let rest = value; rest > 0; rest = Math.floor(rest / 62))
    out = BASE62[rest % 62] + out
  return out.padStart(width, '0')
}

/**
 * Whether a classic GitHub token's last six characters are the CRC32 of its
 * random part. GitHub has issued every `gh?_` token in this form since 2021;
 * one typed by hand or made up for a test passes by chance once in 2^32.
 */
export function hasGitHubChecksum(token: string): boolean {
  return base62(crc32(token.slice(4, -6)), 6) === token.slice(-6)
}

/** `token`'s random part with the checksum GitHub would append, for test fakes. */
export function withGitHubChecksum(prefix: string, body: string): string {
  return `${prefix}${body}${base62(crc32(body), 6)}`
}
