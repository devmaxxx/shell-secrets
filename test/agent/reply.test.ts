import { describe, expect, it } from 'vitest'
import { findCredentialSlotsInReply } from '../../src/agent/reply'

const names = (reply: string): (string | null)[] => findCredentialSlotsInReply(reply).map(slot => slot.name)

describe('findCredentialSlotsInReply: what the user would copy and run', () => {
  it('finds a slot in a fenced command, with offsets into the reply', () => {
    const reply = 'Run this:\n\n```bash\nexport GITHUB_TOKEN=<your-token>\ngh api user\n```\n'
    const [slot] = findCredentialSlotsInReply(reply)
    expect(slot!.name).toBe('GITHUB_TOKEN')
    expect(reply.slice(slot!.start, slot!.end)).toBe('<your-token>')
  })

  it('reads a tilde fence and a longer fence that holds a shorter one', () => {
    expect(names('~~~\nAPI_KEY=paste-here\n~~~')).toEqual(['API_KEY'])
    expect(names('````md\n```sh\nexport TOKEN=<token>\n```\n````')).toEqual(['TOKEN'])
  })

  it('reads an unclosed fence to the end of the reply, as Markdown does', () => {
    expect(names('```sh\nexport TOKEN=<token>')).toEqual(['TOKEN'])
  })

  it('finds a slot in an inline command the user types with !', () => {
    const reply = 'Type `! npm config set //registry/:_authToken=<token>` and retry.'
    const [slot] = findCredentialSlotsInReply(reply)
    expect(reply.slice(slot!.start, slot!.end)).toBe('<token>')
  })

  it('lets prose that only names the pattern through', () => {
    expect(findCredentialSlotsInReply('No more `export KEY=<your-key>` slots in commands.')).toEqual([])
    expect(findCredentialSlotsInReply('Set API_KEY=<your-key> in your shell.')).toEqual([])
  })

  it('lets a fenced command that reads the credential by reference through', () => {
    expect(findCredentialSlotsInReply('```bash\ncurl -H "Authorization: Bearer $(gh auth token)" https://api.github.com\n```')).toEqual([])
  })

  it('reads a long reply of fence markers and backticks in linear time', () => {
    const started = performance.now()
    findCredentialSlotsInReply(`${'`'.repeat(300_000)}\n`)
    findCredentialSlotsInReply('```\n'.repeat(100_000))
    findCredentialSlotsInReply('`!'.repeat(150_000))
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
