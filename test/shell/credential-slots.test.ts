import { describe, expect, it } from 'vitest'
import { findCredentialSlotsInCommand } from '../../src'

describe('findCredentialSlotsInCommand', () => {
  it('finds a slot in the command, quoted or not', () => {
    const cmd = 'curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.github.com/user'
    const [slot] = findCredentialSlotsInCommand(cmd)
    expect(cmd.slice(slot!.start, slot!.end)).toBe('<YOUR_TOKEN>')
    expect(findCredentialSlotsInCommand('bash -c \'export API_KEY=your-key; ./run\'')).toHaveLength(1)
  })

  it('ignores a slot quoted in a heredoc body, such as a PR description', () => {
    expect(findCredentialSlotsInCommand('gh pr create --body-file - <<\'EOF\'\nno more export API_KEY=<your-key>\nEOF')).toEqual([])
    expect(findCredentialSlotsInCommand('git commit -F - <<EOF\nfix: stop writing TOKEN=xxxxxxxx in docs\nEOF')).toEqual([])
  })

  it('still finds a slot on the heredoc header line or after the body', () => {
    const cmd = 'cat <<\'EOF\' | vercel deploy --token <token>\nbody\nEOF\nexport API_KEY=your-key'
    expect(findCredentialSlotsInCommand(cmd).map(slot => slot.name)).toEqual(['--token', 'API_KEY'])
  })

  it('ignores a slot in a comment, which the shell never runs', () => {
    expect(findCredentialSlotsInCommand('gh api user # instead of curl -H "Authorization: Bearer <token>"')).toEqual([])
  })

  it('returns nothing for an empty or non-string command', () => {
    expect(findCredentialSlotsInCommand('')).toEqual([])
    expect(findCredentialSlotsInCommand(undefined as unknown as string)).toEqual([])
  })
})
