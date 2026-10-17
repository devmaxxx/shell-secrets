// Writes the two tool calls the demo replays. The token is assembled here at
// runtime so the repository holds nothing secret-shaped, as in test/fake.ts.
// It carries the CRC32 checksum GitHub appends, without which it reads as made up.
import { writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const body = Array.from({ length: 30 }, (_, i) => alnum[(i * 37 + 11) % alnum.length]).join('')
let checksum = ''
for (let rest = crc32(body); rest > 0; rest = Math.floor(rest / 62))
  checksum = base62[rest % 62] + checksum
const token = ['gh', 'p_', body, checksum.padStart(6, '0')].join('')

const call = command => `${JSON.stringify({ tool_name: 'Bash', tool_input: { command } }, null, 2)}\n`

writeFileSync('leak.json', call(`echo "GITHUB_TOKEN=${token}" >> config.js`))
writeFileSync('safe.json', call('echo "GITHUB_TOKEN=$GITHUB_TOKEN" >> config.js'))
