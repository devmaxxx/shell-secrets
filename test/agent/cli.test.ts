import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/agent/main'
import { fake } from '../support/fake'

const skills = join(import.meta.dirname, '../../skills')

describe('cli', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  afterEach(() => vi.unstubAllEnvs())
  const run = (args: string[], input = '', home = mkdtempSync(join(tmpdir(), 'ss-'))): number => {
    vi.stubEnv('HOME', home)
    return main(args, { stdin: () => input, script: '/opt/shell-secrets/cli.mjs', skills })
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
    main(['install', 'claude'], { stdin: () => '', script: `/opt/cost$5/it's/cli.mjs`, skills })
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

  it('refuses, and leaves the file as it is, when the settings are not an object it can extend', () => {
    for (const text of ['null', '[]', '"x"', '{', '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}', '{"hooks": {"Stop": "x"}}']) {
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
    for (const text of ['{"hooks": null}', '{"hooks": {"PreToolUse": null}}', '{"other": 1, "hooks": null}', '{"hooks": {"Stop": null}}']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, text)
      expect(run(['install', 'claude'], '', home), text).toBe(0)
      const written = JSON.parse(readFileSync(file, 'utf8'))
      expect(written.hooks.PreToolUse, text).toHaveLength(1)
      expect(written.hooks.PreToolUse[0].hooks[0].command, text).toBe(`node '/opt/shell-secrets/cli.mjs' hook || exit 2`)
    }
  })

  it('writes the Codex matcher to hooks.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    run(['install', 'codex'], '', home)
    expect(logs.mock.lastCall?.[0]).toContain('/hooks')
    const entry = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash|apply_patch')
  })

  describe('a credential slot', () => {
    const stop = (fields: Record<string, unknown>): { code: number, out: string } => {
      logs.mockClear()
      const code = run(['hook'], JSON.stringify({ hook_event_name: 'Stop', cwd: '/', ...fields }))
      return { code, out: logs.mock.calls.map(call => String(call[0])).join('') }
    }

    it('blocks a Bash call that would send the stand-in itself, and says what to write instead', () => {
      expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.github.com/user' } }))).toBe(2)
      const message = String(errors.mock.lastCall?.[0])
      expect(message).toContain('Authorization: Bearer <YOUR_TOKEN>')
      expect(message).toContain('$(gh auth token)')
      expect(message).toContain('! gh auth login')
    })

    it('lets a Bash call through whose slot sits in a heredoc body', () => {
      const command = 'gh pr create --body-file - <<\'EOF\'\nno more export API_KEY=<your-key>\nEOF'
      expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))).toBe(0)
    })

    it('reports a live secret before a slot in the same call', () => {
      expect(run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `export T=${fake.github()} K=<your-key>` } }))).toBe(2)
      expect(errors.mock.lastCall?.[0]).toContain('GitHub token')
    })

    it('sends back a reply that hands the user a slot, as JSON on stdout with exit 0', () => {
      const { code, out } = stop({ stop_hook_active: false, last_assistant_message: '```bash\nexport API_KEY=<your-key>\n```' })
      expect(code).toBe(0)
      const answer = JSON.parse(out)
      expect(answer.decision).toBe('block')
      expect(answer.reason).toContain('API_KEY=<your-key>')
      expect(answer.reason).toContain('! gh auth login')
    })

    it('lets the reply stand once a Stop hook has already sent it back', () => {
      expect(stop({ stop_hook_active: true, last_assistant_message: '```bash\nexport API_KEY=<your-key>\n```' })).toEqual({ code: 0, out: '' })
    })

    it('lets a clean reply, prose about a slot, and a missing message stand', () => {
      expect(stop({ last_assistant_message: 'Done: `gh api user` works.' })).toEqual({ code: 0, out: '' })
      expect(stop({ last_assistant_message: 'No more `export KEY=<your-key>` slots.' })).toEqual({ code: 0, out: '' })
      expect(stop({ last_assistant_message: null })).toEqual({ code: 0, out: '' })
      expect(stop({})).toEqual({ code: 0, out: '' })
    })
  })

  describe('the Stop entry', () => {
    const read = (file: string): Record<string, unknown[]> => JSON.parse(readFileSync(file, 'utf8')).hooks

    it('is written once next to the PreToolUse one, without a matcher, and removed by uninstall', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      const other = { hooks: [{ type: 'command', command: 'say done' }] }
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, JSON.stringify({ hooks: { Stop: [other] } }))
      run(['install', 'claude'], '', home)
      run(['install', 'claude'], '', home)
      const stop = read(file).Stop!
      expect(stop).toHaveLength(2)
      expect(stop[0]).toEqual(other)
      expect(stop[1]).toEqual({ hooks: [{ type: 'command', command: `node '/opt/shell-secrets/cli.mjs' hook`, timeout: 10, statusMessage: 'Checking the reply for credential slots' }] })
      expect(read(file).PreToolUse).toHaveLength(1)
      run(['uninstall', 'claude'], '', home)
      expect(read(file).Stop).toEqual([other])
    })

    it('lets the agent stop when the hook cannot start, while PreToolUse still blocks', () => {
      const commands = (file: string): Record<string, string> => Object.fromEntries(Object.entries(read(file) as Record<string, { hooks: { command: string }[] }[]>).map(([event, entries]) => [event, entries[0]!.hooks[0]!.command]))
      const exit = (command: string): number | null => spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' } }).status
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      vi.spyOn(process, 'cwd').mockReturnValue(home)
      run(['install', 'claude'], '', home)
      run(['install', 'codex', '--project'], '', home)
      for (const file of [join(home, '.claude/settings.json'), join(home, '.codex/hooks.json')]) {
        const { PreToolUse, Stop } = commands(file)
        expect(exit(PreToolUse!), PreToolUse).toBe(2)
        expect(exit(Stop!), Stop).not.toBe(2)
        expect(exit(Stop!), Stop).not.toBe(0)
      }
      run(['uninstall', 'codex', '--project'], '', home)
      expect(read(join(home, '.codex/hooks.json'))).toEqual({})
    })
  })

  describe('the credential-handling skill', () => {
    const skill = (base: string, dir: string): string => join(base, dir, 'credential-handling/SKILL.md')

    it('is installed for Claude Code and Codex, kept current, and removed by uninstall', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const shipped = readFileSync(join(skills, 'credential-handling/SKILL.md'), 'utf8')
      for (const [agent, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills']] as const) {
        expect(run(['install', agent], '', home)).toBe(0)
        expect(readFileSync(skill(home, dir), 'utf8')).toBe(shipped)
        writeFileSync(skill(home, dir), 'stale')
        expect(run(['install', agent], '', home)).toBe(0)
        expect(readFileSync(skill(home, dir), 'utf8')).toBe(shipped)
        expect(existsSync(join(home, dir, 'credential-handling/references/where-credentials-live.md'))).toBe(true)
        expect(run(['uninstall', agent], '', home)).toBe(0)
        expect(existsSync(join(home, dir, 'credential-handling'))).toBe(false)
      }
    })

    it('goes into the project with --project', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const project = mkdtempSync(join(tmpdir(), 'ss-project-'))
      vi.spyOn(process, 'cwd').mockReturnValue(project)
      run(['install', 'claude', '--project'], '', home)
      expect(existsSync(skill(project, '.claude/skills'))).toBe(true)
      expect(existsSync(skill(home, '.claude/skills'))).toBe(false)
      run(['uninstall', 'claude', '--project'], '', home)
      expect(existsSync(join(project, '.claude/skills/credential-handling'))).toBe(false)
    })

    it('leaves a skill of the same name it did not install, and still installs the hook', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      mkdirSync(join(home, '.claude/skills/credential-handling'), { recursive: true })
      writeFileSync(skill(home, '.claude/skills'), 'mine')
      expect(run(['install', 'claude'], '', home)).toBe(0)
      expect(errors.mock.lastCall?.[0]).toContain('credential-handling')
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe('mine')
      expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse).toHaveLength(1)
      expect(run(['uninstall', 'claude'], '', home)).toBe(0)
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe('mine')
    })

    it('writes no hook when the skill cannot be installed', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      vi.stubEnv('HOME', home)
      expect(main(['install', 'claude'], { stdin: () => '', script: '/opt/shell-secrets/cli.mjs', skills: join(home, 'missing') })).toBe(1)
      expect(existsSync(join(home, '.claude/settings.json'))).toBe(false)
      const file = join(home, '.claude/settings.json')
      const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.claude/skills'), 'not a directory')
      writeFileSync(file, before)
      expect(run(['install', 'claude'], '', home)).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe(before)
    })

    it('stages the copy beside a directory of the staging name without touching it', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const neighbour = join(home, '.claude/skills', `credential-handling.${process.pid}`)
      mkdirSync(neighbour, { recursive: true })
      writeFileSync(join(neighbour, 'notes.md'), 'mine')
      expect(run(['install', 'claude'], '', home)).toBe(0)
      expect(readFileSync(join(neighbour, 'notes.md'), 'utf8')).toBe('mine')
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe(readFileSync(join(skills, 'credential-handling/SKILL.md'), 'utf8'))
    })

    it('leaves a link in its place alone', () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const elsewhere = mkdtempSync(join(tmpdir(), 'ss-elsewhere-'))
      writeFileSync(join(elsewhere, 'SKILL.md'), 'mine')
      mkdirSync(join(home, '.claude/skills'), { recursive: true })
      symlinkSync(elsewhere, join(home, '.claude/skills/credential-handling'))
      run(['install', 'claude'], '', home)
      run(['uninstall', 'claude'], '', home)
      expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('mine')
      expect(existsSync(skill(home, '.claude/skills'))).toBe(true)
    })
  })
})
