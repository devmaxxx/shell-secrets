import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/agent/main'
import { fake } from '../support/fake'

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

  it('does not exempt an ignored name hard-linked to a tracked file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-repo-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'app.js'), '')
    linkSync(join(repo, 'app.js'), join(repo, '.env'))
    expect(run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env', content: fake.github() }, cwd: repo }))).toBe(2)
  })

  it('blocks a field of the wrong type instead of reading it as empty', () => {
    expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: ['echo', fake.github()] } }))).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: { text: fake.github() } } }))).toBe(2)
  })

  it('reads a payload larger than one pipe buffer from the built cli', () => {
    const cli = join(import.meta.dirname, '../../dist/cli.mjs')
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: `${'x\n'.repeat(40_000)}${fake.github()}` } })
    const result = spawnSync(process.execPath, [cli, 'hook'], { input: payload })
    expect(result.status).toBe(2)
  })

  it('blocks when a project install runs where npx or the package is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    vi.spyOn(process, 'cwd').mockReturnValue(home)
    run(['install', 'codex', '--project'], '', home)
    const command = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
    expect(spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' } }).status).toBe(2)
  })

  it('leaves a user hook that only mentions shell-secrets, and entries it does not understand', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const file = join(home, '.claude/settings.json')
    const others = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/src/shell-secrets-audit/log.sh' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node '/opt/shell-secrets-audit/log.mjs' hook` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx --no-install shell-secrets-audit hook' }] },
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
    expect(spawnSync('sh', ['-c', `printf %s ${command.slice(5, -15)}`]).stdout.toString()).toBe(`/opt/cost$5/it's/cli.mjs`)
    vi.spyOn(process, 'cwd').mockReturnValue(home)
    run(['install', 'codex', '--project'], '', home)
    expect(JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command).toBe('npx --no-install shell-secrets hook || exit 2')
  })

  it('scans the ignored files a forced add of a directory or the whole tree stages', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-add-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\ndist/\n')
    mkdirSync(join(repo, 'dist'))
    writeFileSync(join(repo, 'dist/app.js'), 'clean')
    const add = (command: string): number => run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }))
    expect(add('git add -f dist/')).toBe(0)
    expect(add('git add -Af && git commit -m x')).toBe(0)
    writeFileSync(join(repo, '.env'), `T=${fake.github()}\n`)
    expect(add('git add -f -A')).toBe(2)
    expect(add('git add -f dist/')).toBe(0)
    writeFileSync(join(repo, 'dist/config.js'), `const t = '${fake.github()}'`)
    expect(add('git add -f dist')).toBe(2)
    expect(add('git add -u -f')).toBe(0)
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
    expect(twice[1]).toMatchObject({ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ command: `node '/opt/shell-secrets/cli.mjs' hook || exit 2` }] })
    run(['uninstall', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([other])
  })

  it('replaces an entry written before the hook command failed closed', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const file = join(home, '.claude/settings.json')
    mkdirSync(join(home, '.claude'))
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '/opt/shell-secrets/cli.mjs' hook` }] }] } }))
    run(['install', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toHaveLength(1)
  })

  it('writes the Codex matcher to hooks.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    run(['install', 'codex'], '', home)
    expect(logs.mock.lastCall?.[0]).toContain('/hooks')
    const entry = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash|apply_patch')
  })
})
