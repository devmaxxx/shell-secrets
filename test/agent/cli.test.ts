import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/agent/main'
import { fake } from '../support/fake'

describe('cli', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  afterEach(() => vi.unstubAllEnvs())
  const fakeBuild = (body = 'cli'): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-build-'))
    writeFileSync(join(dir, 'cli.mjs'), `import './chunk.mjs' // ${body}`)
    writeFileSync(join(dir, 'chunk.mjs'), '')
    writeFileSync(join(dir, 'cli.d.mts'), '')
    return join(dir, 'cli.mjs')
  }
  const script = fakeBuild()
  const run = (args: string[], input = '', home = mkdtempSync(join(tmpdir(), 'ss-')), from = script): number => {
    vi.stubEnv('HOME', home)
    return main(args, { stdin: () => input, script: from, execPath: process.execPath, node: 'v22.0.0' })
  }
  const hookOf = (file: string): string => JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse.at(-1).hooks[0].command
  const OWN = /^n='.+'; \[ -x "\$n" \] \|\| n=node; "\$n" '.+\/\.shell-secrets\/current\/cli\.mjs' hook \|\| exit 2$/
  const scriptOf = (command: string): string => realpathSync(command.slice(command.indexOf(`"$n" '`) + 6, -16))

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

  it('blocks a tool input or an edit list of the wrong shape instead of reading it as empty', () => {
    const token = fake.github()
    expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: `export T=${token}` }))).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: { new_string: token } } }))).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: [token] } }))).toBe(2)
    expect(run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js' } }))).toBe(0)
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
    vi.stubEnv('HOME', join(home, `cost$5`, `it's`))
    main(['install', 'claude'], { stdin: () => '', script, execPath: process.execPath, node: 'v22.0.0' })
    const command = hookOf(join(home, `cost$5/it's/.claude/settings.json`))
    expect(spawnSync('sh', ['-c', `printf %s ${command.slice(command.lastIndexOf('"$n" ') + 5, -15)}`]).stdout.toString()).toBe(`${home}/cost$5/it's/.shell-secrets/current/cli.mjs`)
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

  it('blocks a message file it will not read instead of waiting on it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-msg-'))
    spawnSync('git', ['init', '-q', repo])
    const commit = (path: string): number => run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `git commit -F ${path}` }, cwd: repo }))
    writeFileSync(join(repo, 'msg.txt'), 'fix: x\n')
    expect(commit('msg.txt')).toBe(0)
    if (process.platform !== 'win32')
      expect(commit('/dev/zero')).toBe(2)
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
    expect(twice[1]).toMatchObject({ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ command: expect.stringMatching(OWN) }] })
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

  it('refuses, and leaves the file as it is, when the settings are not an object it can extend', () => {
    for (const text of ['null', '[]', '"x"', '{', '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, text)
      logs.mockClear()
      for (const command of ['install', 'uninstall']) {
        expect(run([command, 'claude'], '', home), text).toBe(1)
        expect(errors.mock.lastCall?.[0], text).toContain(file)
      }
      expect(readFileSync(file, 'utf8'), text).toBe(text)
      expect(logs).not.toHaveBeenCalled()
    }
  })

  it('writes the hook in when hooks or PreToolUse is null, treating it as absent', () => {
    for (const text of ['{"hooks": null}', '{"hooks": {"PreToolUse": null}}', '{"other": 1, "hooks": null}']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, text)
      expect(run(['install', 'claude'], '', home), text).toBe(0)
      const written = JSON.parse(readFileSync(file, 'utf8'))
      expect(written.hooks.PreToolUse, text).toHaveLength(1)
      expect(written.hooks.PreToolUse[0].hooks[0].command, text).toMatch(OWN)
    }
  })

  it('runs a copy of the build that outlives the package and keeps each build apart', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const from = fakeBuild('one')
    run(['install', 'claude'], '', home, from)
    const first = scriptOf(hookOf(join(home, '.claude/settings.json')))
    expect(readdirSync(join(first, '..')).sort()).toEqual(['chunk.mjs', 'cli.mjs'])
    rmSync(join(from, '..'), { recursive: true })
    expect(readFileSync(first, 'utf8')).toBe(`import './chunk.mjs' // one`)
    run(['install', 'codex'], '', home, fakeBuild('one'))
    expect(hookOf(join(home, '.codex/hooks.json'))).toBe(hookOf(join(home, '.claude/settings.json')))
    expect(scriptOf(hookOf(join(home, '.codex/hooks.json')))).toBe(first)
    run(['install', 'claude'], '', home, fakeBuild('two'))
    const second = scriptOf(hookOf(join(home, '.claude/settings.json')))
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(true)
    expect(readdirSync(join(home, '.shell-secrets'))).toHaveLength(3)
    rmSync(second)
    run(['install', 'claude'], '', home, fakeBuild('two'))
    expect(readFileSync(second, 'utf8')).toBe(`import './chunk.mjs' // two`)
    expect(readdirSync(join(home, '.shell-secrets'))).toHaveLength(3)
  })

  it('runs on the Node.js that installed it, falls back to PATH once that is gone, and blocks a hook that cannot start in Claude Code', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    vi.stubEnv('HOME', home)
    const clean = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    const pathBin = mkdtempSync(join(tmpdir(), 'ss-bin-'))
    writeFileSync(join(pathBin, 'node'), '#!/bin/sh\necho path >&2\nexit 1\n', { mode: 0o755 })
    const env = { HOME: home, PATH: `${pathBin}:/usr/bin:/bin` }
    const build = join(mkdtempSync(join(tmpdir(), 'ss-build-')), 'cli.mjs')
    writeFileSync(build, 'process.stdout.write(process.argv.slice(2).join(\' \'))\n')
    for (const [node, status, stdout, stderr] of [[process.execPath, 0, 'hook', ''], [join(home, 'gone/node'), 2, '', 'path\n']] as const) {
      main(['install', 'claude'], { stdin: () => '', script: build, execPath: node, node: 'v22.0.0' })
      const hooks = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse
      expect(hooks).toHaveLength(1)
      expect(hooks[0].hooks[0].onFailure).toBe('block')
      const ran = spawnSync('sh', ['-c', hooks[0].hooks[0].command], { input: clean, env })
      expect(ran.status, node).toBe(status)
      expect(ran.stdout.toString()).toBe(stdout)
      expect(ran.stderr.toString()).toBe(stderr)
    }
    main(['install', 'codex'], { stdin: () => '', script, execPath: process.execPath, node: 'v22.0.0' })
    expect(JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0]).not.toHaveProperty('onFailure')
  })

  it('refuses to replace a current that is not its link, and leaves no temporary link behind', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    mkdirSync(join(home, '.shell-secrets/current'), { recursive: true })
    expect(run(['install', 'claude'], '', home)).toBe(1)
    expect(errors.mock.lastCall?.[0]).toContain('is not the link install writes')
    expect(readdirSync(join(home, '.shell-secrets')).filter(name => name.startsWith('current'))).toEqual(['current'])
  })

  it('refuses to install from an entry that is not a build', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    expect(run(['install', 'claude'], '', home, join(script, '../../src/cli.ts'))).toBe(1)
    expect(run(['install', 'claude'], '', home, join(script, '../missing.mjs'))).toBe(1)
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it('blocks the hook and refuses to install on a Node.js older than 22', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    vi.stubEnv('HOME', home)
    const clean = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(main(['hook'], { stdin: () => clean, script, execPath: process.execPath, node: 'v20.20.2' })).toBe(2)
    expect(errors.mock.lastCall?.[0]).toContain('Node.js 22 or later')
    expect(main(['install', 'claude'], { stdin: () => '', script, execPath: process.execPath, node: 'v18.20.6' })).toBe(1)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(main(['hook'], { stdin: () => clean, script, execPath: process.execPath, node: 'node' })).toBe(2)
    expect(main(['hook'], { stdin: () => clean, script, execPath: process.execPath, node: 'v22.13.1' })).toBe(0)
    main(['install', 'claude'], { stdin: () => '', script, execPath: process.execPath, node: 'v22.13.1' })
    expect(main(['uninstall', 'claude'], { stdin: () => '', script, execPath: process.execPath, node: 'v20.20.2' })).toBe(0)
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse).toBeUndefined()
  })

  it('writes the Codex matcher to hooks.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    run(['install', 'codex'], '', home)
    expect(logs.mock.lastCall?.[0]).toContain('/hooks')
    const entry = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash|apply_patch')
  })
})
