// Writes the two tool calls the demo replays. The token is assembled here at
// runtime so the repository holds nothing secret-shaped, as in test/fake.ts.
import { writeFileSync } from 'node:fs'

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const body = Array.from({ length: 36 }, (_, i) => alnum[(i * 37 + 11) % alnum.length]).join('')
const token = ['gh', 'p_', body].join('')

const call = command => `${JSON.stringify({ tool_name: 'Bash', tool_input: { command } }, null, 2)}\n`

writeFileSync('leak.json', call(`echo "GITHUB_TOKEN=${token}" >> config.js`))
writeFileSync('safe.json', call('echo "GITHUB_TOKEN=$GITHUB_TOKEN" >> config.js'))
