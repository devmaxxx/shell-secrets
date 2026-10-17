import type { GuardEnv } from '../src'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkToolCall } from '../src'
import { main } from '../src/agents'
import { fake } from './fake'

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
    expect(ids({ kind: 'shell', command: 'cd notes && gh issue create --body-file body.md' }, env())).toEqual(['unreadable-message-file'])
    expect(ids({ kind: 'shell', command: 'gh issue create --body-file "$DIR/body.md"' }, env())).toEqual(['unreadable-message-file'])
    expect(ids({ kind: 'shell', command: 'echo fix > msg.txt && git commit -F msg.txt' }, env())).toEqual([])
  })

  it('does not carry an ignored file\'s exemption past a CRLF or unknown header', () => {
    const token = fake.github()
    const crlf = ['*** Add File: .env', `+T=${token}`, '*** Add File: config.js', `+const t = '${fake.github()}'`].join('\r\n')
    expect(ids({ kind: 'patch', patch: crlf }, env())).toEqual(['github-token'])
    const unknown = ['*** Add File: .env', '*** Copy File: config.js', `+${token}`].join('\n')
    expect(ids({ kind: 'patch', patch: unknown }, env())).toEqual(['github-token'])
  })

  it('follows a patch that moves an ignored file into a tracked one', () => {
    const patch = ['*** Update File: .env', '*** Move to: config.js', '@@', `+${fake.github()}`].join('\n')
    expect(ids({ kind: 'patch', patch }, env())).toEqual(['github-token'])
  })
})

describe('cli', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  afterEach(() => vi.unstubAllEnvs())
  const run = (args: string[], input = '', home = mkdtempSync(join(tmpdir(), 'ss-'))): number => {
    vi.stubEnv('HOME', home)
    return main(args, { stdin: () => input, script: '/opt/shell-secrets/cli.mjs' })
  }

  it('blocks a Claude Bash call and a Codex apply_patch call with exit 2', () => {
    const bash = run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `export T=${fake.github()}` } }))
    expect(bash).toBe(2)
    expect(errors.mock.lastCall?.[0]).toContain('GitHub token')
    const patch = `*** Begin Patch\n*** Add File: a.js\n+${fake.github()}\n*** End Patch`
    expect(run(['hook'], JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: patch } }))).toBe(2)
  })

  it('blocks a payload it cannot read instead of letting the call run', () => {
    expect(run(['hook'], '')).toBe(2)
    expect(run(['hook'], '{"tool_name":')).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: null, cwd: null }))).toBe(0)
  })

  it('scans MultiEdit and NotebookEdit calls', () => {
    const edits = [{ old_string: 'a', new_string: fake.github() }]
    expect(run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits } }))).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb', new_source: fake.github() } }))).toBe(2)
  })

  it('does not exempt a write to an ignored name that links to a tracked file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-repo-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'app.js'), '')
    const write = (path: string): number => run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path, content: fake.github() }, cwd: repo }))
    expect(write('.env')).toBe(0)
    symlinkSync('app.js', join(repo, '.env'))
    expect(write('.env')).toBe(2)
  })

  it('leaves a user hook that only mentions shell-secrets, and entries it does not understand', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const file = join(home, '.claude/settings.json')
    const others = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/src/shell-secrets-audit/log.sh' }] },
      { matcher: 'Bash' },
      { matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'safe?' }] },
    ]
    mkdirSync(join(home, '.claude'))
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: others } }))
    run(['install', 'claude'], '', home)
    run(['uninstall', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual(others)
  })

  it('quotes a script path holding a $ and names the package in a project install', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    vi.stubEnv('HOME', home)
    main(['install', 'claude'], { stdin: () => '', script: `/opt/cost$5/it's/cli.mjs` })
    const command = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
    expect(spawnSync('sh', ['-c', `printf %s ${command.slice(5, -5)}`]).stdout.toString()).toBe(`/opt/cost$5/it's/cli.mjs`)
    vi.spyOn(process, 'cwd').mockReturnValue(home)
    run(['install', 'codex', '--project'], '', home)
    expect(JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command).toBe('npx --no-install shell-secrets hook')
  })

  it('passes a clean call and an unknown tool', () => {
    expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe(0)
    expect(run(['hook'], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }))).toBe(0)
  })

  it('installs once, keeps other hooks, and uninstalls', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const file = join(home, '.claude/settings.json')
    run(['install', 'claude'], '', home)
    const other = { matcher: '*', hooks: [{ type: 'command', command: 'other' }] }
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    settings.hooks.PreToolUse.unshift(other)
    writeFileSync(file, JSON.stringify(settings))
    run(['install', 'claude'], '', home)
    const twice = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse
    expect(twice).toHaveLength(2)
    expect(twice[1]).toMatchObject({ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ command: `node '/opt/shell-secrets/cli.mjs' hook` }] })
    run(['uninstall', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([other])
  })

  it('writes the Codex matcher to hooks.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    run(['install', 'codex'], '', home)
    expect(logs.mock.lastCall?.[0]).toContain('/hooks')
    const entry = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash|apply_patch')
  })
})
