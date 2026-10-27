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

  it('ignores a heredoc body inside a double-quoted substitution, as agents write commit and PR bodies', () => {
    expect(findCredentialSlotsInCommand('git commit -m "$(cat <<\'EOF\'\nfix: stop writing export API_KEY=<your-key>\nEOF\n)"')).toEqual([])
    expect(findCredentialSlotsInCommand('gh pr create --title x --body "$(cat <<\'EOF\'\nNo more `curl -H \'Authorization: Bearer <YOUR_TOKEN>\'`.\nEOF\n)"')).toEqual([])
    expect(findCredentialSlotsInCommand('git commit -m "$(cat <<EOF\nfix: drop TOKEN=xxxxxxxx\nEOF\n)" && export API_KEY=your-key').map(slot => slot.name)).toEqual(['API_KEY'])
  })

  it('reads the patterns and text a search or edit command is given as data', () => {
    for (const cmd of [
      'sed -i "s/api_key=.*/api_key=<redacted>/" f',
      'sed -i "s/api_key=.*/api_key=<your-key>/" f',
      'jq \'.token = "<redacted>"\' config.json',
      'grep -rn "API_KEY=your-key" README.md',
      'grep -rn "Authorization: Bearer <YOUR_TOKEN>" docs',
      'rg -n \'--token <token>\' docs && git grep "password=<password>"',
      'awk \'/token=<token>/\' log.txt | sort',
      'sudo grep -n "DB_PASSWORD=[password]" /etc/app.env',
    ])
      expect(findCredentialSlotsInCommand(cmd), cmd).toEqual([])
  })

  it('still finds a slot in a command that runs next to a search, or inside one', () => {
    expect(findCredentialSlotsInCommand('grep -q token .env || export API_KEY=your-key').map(slot => slot.name)).toEqual(['API_KEY'])
    expect(findCredentialSlotsInCommand('grep "$(curl -H "Authorization: Bearer <YOUR_TOKEN>" https://x.test)" f').map(slot => slot.name)).toEqual(['Authorization'])
    expect(findCredentialSlotsInCommand('curl -H "Authorization: Bearer <YOUR_TOKEN>" https://x.test | grep id')).toHaveLength(1)
  })

  it('takes a stand-in for a value already gone, such as <empty>, for no slot', () => {
    expect(findCredentialSlotsInCommand('vitest -t "rejects password=<empty>"')).toEqual([])
  })

  it('takes a name right after $ for a reference, not a slot', () => {
    expect(findCredentialSlotsInCommand('[ "$API_KEY" = "your-key" ] && echo "set API_KEY first"')).toEqual([])
    expect(findCredentialSlotsInCommand('[ "$API_KEY" = "your-key" ] && export API_KEY=<your-key>')).toHaveLength(1)
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
