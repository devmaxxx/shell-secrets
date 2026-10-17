import type { GuardEnv } from '../../src'
import { describe, expect, it } from 'vitest'
import { checkToolCall } from '../../src'
import { fake } from '../support/fake'

function env(files: Record<string, string> = {}): GuardEnv {
  return {
    isIgnored: path => path.endsWith('.env'),
    readFile: path => files[path] ?? null,
  }
}
const ids = (...args: Parameters<typeof checkToolCall>): string[] => checkToolCall(...args).map(f => f.ruleId)

describe('checkToolCall', () => {
  it('blocks a shell write into a tracked file and allows one into an ignored file', () => {
    const token = fake.github()
    expect(ids({ kind: 'shell', command: `echo "T=${token}" >> config.js` }, env())).toEqual(['github-token'])
    expect(ids({ kind: 'shell', command: `echo "T=${token}" >> .env` }, env())).toEqual([])
  })

  it('blocks an ignored write chained to a copy', () => {
    expect(ids({ kind: 'shell', command: `echo "${fake.github()}" > .env; cp .env config.js` }, env())).toEqual(['github-token'])
  })

  it('scans the message file git commit -F publishes', () => {
    const files = { 'msg.txt': `fix\n\n${fake.github()}\n` }
    expect(ids({ kind: 'shell', command: 'git commit -F msg.txt' }, env(files))).toEqual(['github-token'])
  })

  it('exempts writes and edits to an ignored file', () => {
    const token = fake.github()
    expect(ids({ kind: 'write', path: '.env', content: token }, env())).toEqual([])
    expect(ids({ kind: 'write', path: 'config.js', content: token }, env())).toEqual(['github-token'])
    expect(ids({ kind: 'edit', path: 'config.js', before: 'a', after: token }, env())).toEqual(['github-token'])
  })

  it('lets an edit keep a secret it does not add', () => {
    const token = fake.github()
    expect(ids({ kind: 'edit', path: 'config.js', before: `${token} a`, after: `${token} b` }, env())).toEqual([])
  })

  it('scans only added patch lines outside ignored files', () => {
    const token = fake.github()
    const patch = [
      '*** Begin Patch',
      '*** Add File: .env',
      `+T=${token}`,
      '*** Update File: config.js',
      '@@',
      `-const t = '${token}'`,
      '+const t = process.env.T',
      '*** End Patch',
    ].join('\n')
    expect(ids({ kind: 'patch', patch }, env())).toEqual([])
    const leak = patch.replace('process.env.T', `'${fake.github()}'`)
    expect(ids({ kind: 'patch', patch: leak }, env())).toEqual(['github-token'])
  })

  it('blocks a message file it cannot read, unless the command writes it first', () => {
    expect(ids({ kind: 'shell', command: 'cd notes && gh issue create --body-file body.md' }, env())).toEqual(['unscanned-published-file'])
    expect(ids({ kind: 'shell', command: 'gh issue create --body-file "$DIR/body.md"' }, env())).toEqual(['unscanned-published-file'])
    expect(ids({ kind: 'shell', command: 'echo fix > msg.txt && git commit -F msg.txt' }, env())).toEqual([])
  })

  it('does not carry an ignored file\'s exemption past a CRLF or unknown header', () => {
    const token = fake.github()
    const crlf = ['*** Add File: .env', `+T=${token}`, '*** Add File: config.js', `+const t = '${fake.github()}'`].join('\r\n')
    expect(ids({ kind: 'patch', patch: crlf }, env())).toEqual(['github-token'])
    const unknown = ['*** Add File: .env', '*** Copy File: config.js', `+${token}`].join('\n')
    expect(ids({ kind: 'patch', patch: unknown }, env())).toEqual(['github-token'])
  })

  it('scans a file git add -f forces past .gitignore', () => {
    const files = { '.env': `T=${fake.github()}\n`, 'notes.md': 'clean' }
    expect(ids({ kind: 'shell', command: 'git add -f .env && git commit -m wip' }, env(files))).toEqual(['github-token'])
    expect(ids({ kind: 'shell', command: 'git add --force -- notes.md' }, env(files))).toEqual([])
    expect(ids({ kind: 'shell', command: 'git add .env' }, env(files))).toEqual([])
  })

  it('scans the file a message is piped or redirected from', () => {
    const files = { 'notes.md': `see ${fake.github()}` }
    expect(ids({ kind: 'shell', command: 'cat notes.md | gh issue create --title t --body-file -' }, env(files))).toEqual(['github-token'])
    expect(ids({ kind: 'shell', command: 'git commit -F - < notes.md' }, env(files))).toEqual(['github-token'])
    expect(ids({ kind: 'shell', command: `git commit -F - <<'EOF'\nfix\nEOF` }, env(files))).toEqual([])
    expect(ids({ kind: 'shell', command: 'echo fix | git commit -F -' }, env(files))).toEqual([])
  })

  it('blocks what it publishes but cannot pin to a file', () => {
    const files = { '.env': `T=${fake.github()}\n`, 'notes.md': 'clean', 'list.txt': '.env' }
    for (const command of [
      'git add -f --pathspec-from-file=list.txt',
      'cd sub && git add -f .env',
      'git -C sub add -f .env',
      'cat notes.md | tee t | gh pr create -F -',
      'sed s/a/b/ notes.md | gh pr create --body-file -',
      'cat .env > body.md && gh pr create -F body.md',
      'echo "$(cat .env)" > body.md && gh pr create --body-file body.md',
      'cat > msg.txt <<EOF\n$T\nEOF\ngit commit -F msg.txt',
      'echo "$(cat .env)" | gh pr create -F -',
      'printf "$(cat .env)" | gh pr create -F -',
      'gh pr create -F - <<EOF\n$(cat .env)\nEOF',
      'gh pr create --body-file - <<< "$(cat .env)"',
      'echo ok > /tmp/m && cp .env /tmp/m && git commit -F /tmp/m',
      'cp .env notes.md && gh pr create --body-file notes.md',
      'cp .env ./notes.md && gh pr create --body-file notes.md',
    ])
      expect(ids({ kind: 'shell', command }, env(files)), command).toEqual(['unscanned-published-file'])
  })

  it('reads every file a pipe or redirect feeds a message from', () => {
    const files = { 'notes.md': `see ${fake.github()}` }
    for (const command of [
      'cat < notes.md | gh pr create --body-file -',
      'cat notes.md |& gh pr create -F -',
      'cat notes.md | (gh pr create -F -)',
      'tail -n +2 notes.md | gh pr create -F -',
      'head -c 1k notes.md | git commit -F -',
    ])
      expect(ids({ kind: 'shell', command }, env(files)), command).toEqual(['github-token'])
    expect(ids({ kind: 'shell', command: 'tail -n +2 notes.md | gh pr create -F -' }, env({ 'notes.md': 'clean' }))).toEqual([])
  })

  it('trusts a message file the command writes from literal text', () => {
    for (const command of [
      'echo fix > msg.txt && git commit -F msg.txt',
      `cat > msg.txt <<'EOF'\nfix: $not expanded\nEOF\ngit commit -F msg.txt`,
      'cat > msg.txt <<EOF\nfix\nEOF\ngit commit -F msg.txt',
      `cat <<'EOF' | gh pr create -F -\nfix: $not expanded\nEOF`,
      'printf "feat: x\\n" | tee /tmp/msg >/dev/null && git commit -F /tmp/msg',
      `gh pr create -F - <<'EOF'\n$(not run)\nEOF`,
    ])
      expect(ids({ kind: 'shell', command }, env()), command).toEqual([])
    expect(ids({ kind: 'shell', command: 'cat msg.txt && git commit -F msg.txt' }, env({ 'msg.txt': 'fix' }))).toEqual([])
  })

  it('follows a patch that moves an ignored file into a tracked one', () => {
    const patch = ['*** Update File: .env', '*** Move to: config.js', '@@', `+${fake.github()}`].join('\n')
    expect(ids({ kind: 'patch', patch }, env())).toEqual(['github-token'])
  })
})
