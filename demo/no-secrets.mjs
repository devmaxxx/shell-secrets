// The README's PreToolUse hook recipe; `shell-secrets` resolves to this package's own build.
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { findNewSecrets, findSecrets, findSecretsInCommand } from 'shell-secrets'

const { tool_name: tool, tool_input: input } = JSON.parse(readFileSync(0, 'utf8'))

let findings = []
if (tool === 'Bash')
  findings = findSecretsInCommand(input.command).findings
else if (tool === 'Edit')
  findings = findNewSecrets(input.old_string, input.new_string)
else if (tool === 'Write')
  findings = findSecrets(input.content)

if (findings.length > 0) {
  const list = findings.map(f => `${f.name} (${f.preview})${f.env ? `: use $${f.env}` : ''}`)
  console.error(`Blocked, the call contains a secret:\n${list.join('\n')}`)
  process.exit(2)
}
