import type { CliIO, HookPlugin } from 'agent-base-kit'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCli } from 'agent-base-kit'
import { describe, expect, it } from 'vitest'
import { HOOK_TIMEOUT_S, TIME_BUDGET_MS } from '../../src/agent/constants'
import { shellSecrets } from '../../src/agent/hook'
import { fake } from '../support/fake'

const skills = join(import.meta.dirname, '../../skills')
const plugin = shellSecrets(skills)

describe('cli', () => {
  const fakeBuild = (body = 'cli'): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-build-'))
    writeFileSync(join(dir, 'cli.mjs'), `import './chunk.mjs' // ${body}`)
    writeFileSync(join(dir, 'chunk.mjs'), '')
    writeFileSync(join(dir, 'cli.d.mts'), '')
    return join(dir, 'cli.mjs')
  }
  const script = fakeBuild()
  let stdout = ''
  let stderr = ''
  const main = (args: string[], io: Partial<CliIO> = {}, hook: HookPlugin = plugin): Promise<number> => {
    stdout = ''
    stderr = ''
    const home = io.home ?? mkdtempSync(join(tmpdir(), 'ss-'))
    return createCli(hook)(args, {
      stdin: () => '',
      script,
      node: 'v22.0.0',
      execPath: process.execPath,
      home,
      cwd: home,
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
      ...io,
    })
  }
  const run = (args: string[], input = '', home = mkdtempSync(join(tmpdir(), 'ss-')), from = script, cwd = home): Promise<number> =>
    main(args, { stdin: () => input, home, script: from, cwd })
  const hookOf = (file: string): string => JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse.at(-1).hooks[0].command
  const OWN = /^n='.+'; \[ -x "\$n" \] \|\| n=node; "\$n" '.+\/\.shell-secrets\/current\/cli\.mjs' hook --event PreToolUse --agent claude \|\| exit 2$/
  const scriptOf = (command: string): string => realpathSync(command.slice(command.indexOf(`"$n" '`) + 6, command.lastIndexOf(`' hook `)))

  it('blocks a Claude Bash call and a Codex apply_patch call with exit 2, naming the secret', async () => {
    const bash = await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `export T=${fake.github()}` } }))
    expect(bash).toBe(2)
    expect(stderr).toMatch(/^Blocked by shell-secrets, the call contains a secret:\nGitHub token .*\nReference it through an environment variable, or write it only to a gitignored file such as \.env\.\n$/)
    const patch = `*** Begin Patch\n*** Add File: a.js\n+${fake.github()}\n*** End Patch`
    expect(await run(['hook'], JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: patch } }))).toBe(2)
  })

  it('blocks a payload it cannot read instead of letting the call run', async () => {
    expect(await run(['hook'], '')).toBe(2)
    expect(stderr).toMatch(/^Blocked by shell-secrets, it could not check the call: /)
    expect(await run(['hook'], '{"tool_name":')).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_input: { command: 'ls' } }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: null, cwd: null }))).toBe(0)
  })

  it('scans MultiEdit and NotebookEdit calls', async () => {
    const edits = [{ old_string: 'a', new_string: fake.github() }]
    expect(await run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits } }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb', new_source: fake.github() } }))).toBe(2)
  })

  it('does not exempt a write to an ignored name that links to a tracked file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-repo-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'app.js'), '')
    const write = (path: string): Promise<number> => run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path, content: fake.github() }, cwd: repo }))
    expect(await write('.env')).toBe(0)
    symlinkSync('app.js', join(repo, '.env'))
    expect(await write('.env')).toBe(2)
  })

  it('does not exempt an ignored name hard-linked to a tracked file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-repo-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'app.js'), '')
    linkSync(join(repo, 'app.js'), join(repo, '.env'))
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env', content: fake.github() }, cwd: repo }))).toBe(2)
  })

  it('checks a write against the working directory the hook runs in when the payload names none', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-repo-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env', content: fake.github() } })
    expect(await main(['hook'], { stdin: () => input, cwd: repo })).toBe(0)
    expect(await main(['hook'], { stdin: () => input })).toBe(2)
  })

  it('blocks a field of the wrong type instead of reading it as empty', async () => {
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: ['echo', fake.github()] } }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: { text: fake.github() } } }))).toBe(2)
  })

  it('blocks a tool input or an edit list of the wrong shape instead of reading it as empty', async () => {
    const token = fake.github()
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: `export T=${token}` }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: { new_string: token } } }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: [token] } }))).toBe(2)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.js' } }))).toBe(0)
  })

  it('reads a payload larger than one pipe buffer from the built cli, and exits 0 on a clean call', () => {
    const cli = join(import.meta.dirname, '../../dist/cli.mjs')
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: `${'x\n'.repeat(40_000)}${fake.github()}` } })
    expect(spawnSync(process.execPath, [cli, 'hook'], { input: payload }).status).toBe(2)
    const clean = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(spawnSync(process.execPath, [cli, 'hook'], { input: clean }).status).toBe(0)
  })

  it('bundles everything the built cli runs, so a copy of dist runs on its own', () => {
    for (const file of readdirSync(join(import.meta.dirname, '../../dist')).filter(name => name.endsWith('.mjs')))
      expect(readFileSync(join(import.meta.dirname, '../../dist', file), 'utf8'), file).not.toMatch(/from ['"](?!node:|\.)/)
  })

  it('blocks when a project install runs where npx or the package is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    await main(['install', 'codex', '--project'], { home, cwd: home })
    const command = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
    expect(spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' } }).status).toBe(2)
  })

  it('leaves a user hook that only mentions shell-secrets, and entries it does not understand', async () => {
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
    await run(['install', 'claude'], '', home)
    await run(['uninstall', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual(others)
  })

  it('quotes a script path holding a $ and names the package in a project install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const quoted = join(home, `cost$5`, `it's`)
    mkdirSync(quoted, { recursive: true })
    await main(['install', 'claude'], { home: quoted })
    const command = hookOf(join(quoted, '.claude/settings.json'))
    expect(spawnSync('sh', ['-c', `printf %s ${command.slice(command.lastIndexOf('"$n" ') + 5, command.lastIndexOf(' hook '))}`]).stdout.toString()).toBe(`${home}/cost$5/it's/.shell-secrets/current/cli.mjs`)
    await main(['install', 'codex', '--project'], { home, cwd: home })
    expect(JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command).toBe('npx --no-install shell-secrets hook --event PreToolUse --agent codex || exit 2')
  })

  it('scans the ignored files a forced add of a directory or the whole tree stages', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-add-'))
    spawnSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\ndist/\n')
    mkdirSync(join(repo, 'dist'))
    writeFileSync(join(repo, 'dist/app.js'), 'clean')
    const add = (command: string): Promise<number> => run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }))
    expect(await add('git add -f dist/')).toBe(0)
    expect(await add('git add -Af && git commit -m x')).toBe(0)
    writeFileSync(join(repo, '.env'), `T=${fake.github()}\n`)
    expect(await add('git add -f -A')).toBe(2)
    expect(await add('git add -f dist/')).toBe(0)
    writeFileSync(join(repo, 'dist/config.js'), `const t = '${fake.github()}'`)
    expect(await add('git add -f dist')).toBe(2)
    expect(await add('git add -u -f')).toBe(0)
  })

  it('blocks a message file it will not read instead of waiting on it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ss-msg-'))
    spawnSync('git', ['init', '-q', repo])
    const commit = (path: string): Promise<number> => run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `git commit -F ${path}` }, cwd: repo }))
    writeFileSync(join(repo, 'msg.txt'), 'fix: x\n')
    expect(await commit('msg.txt')).toBe(0)
    if (process.platform !== 'win32')
      expect(await commit('/dev/zero')).toBe(2)
  })

  it('passes a clean call and an unknown tool', async () => {
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe(0)
    expect(await run(['hook'], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }))).toBe(0)
  })

  it('installs once, keeps other hooks, and uninstalls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const file = join(home, '.claude/settings.json')
    await run(['install', 'claude'], '', home)
    const other = { matcher: '*', hooks: [{ type: 'command', command: 'other' }] }
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    settings.hooks.PreToolUse.unshift(other)
    writeFileSync(file, JSON.stringify(settings))
    await run(['install', 'claude'], '', home)
    const twice = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse
    expect(twice).toHaveLength(2)
    expect(twice[1]).toMatchObject({ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ command: expect.stringMatching(OWN), timeout: 10, statusMessage: 'Scanning for secrets', onFailure: 'block' }] })
    await run(['uninstall', 'claude'], '', home)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([other])
  })

  it('replaces and removes every command form an earlier install wrote', async () => {
    const own = [
      `node '/opt/shell-secrets/cli.mjs' hook`,
      `node '/usr/lib/node_modules/shell-secrets/dist/cli.mjs' hook || exit 2`,
      `node '/home/me/code/shell-secrets-fork/dist/cli.mjs' hook || exit 2`,
      `node '/home/me/code/my-shell-secrets/dist/cli.mjs' hook`,
      `n='/usr/bin/node'; [ -x "$n" ] || n=node; "$n" '/home/it'\\''s/.shell-secrets/current/cli.mjs' hook || exit 2`,
      'npx --no-install shell-secrets hook',
      'npx --no-install shell-secrets hook || exit 2',
    ]
    for (const command of ['install', 'uninstall']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: own.map(c => ({ matcher: 'Bash', hooks: [{ type: 'command', command: c }] })) } }))
      expect(await run([command, 'claude'], '', home)).toBe(0)
      const left = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse
      if (command === 'install')
        expect(left.map((entry: any) => entry.hooks[0].command)).toEqual([expect.stringMatching(OWN)])
      else
        expect(left).toBeUndefined()
    }
  })

  it('refuses, and leaves the file as it is, when the settings are not an object it can extend', async () => {
    for (const text of ['null', '[]', '"x"', '{', '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}', '{"hooks": {"Stop": "x"}}']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, text)
      for (const command of ['install', 'uninstall']) {
        expect(await run([command, 'claude'], '', home), text).toBe(1)
        expect(stderr, text).toContain(file)
        expect(stdout, text).toBe('')
      }
      expect(readFileSync(file, 'utf8'), text).toBe(text)
    }
  })

  it('writes the hook in when hooks or PreToolUse is null, treating it as absent', async () => {
    for (const text of ['{"hooks": null}', '{"hooks": {"PreToolUse": null}}', '{"other": 1, "hooks": null}', '{"hooks": {"Stop": null}}']) {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, text)
      expect(await run(['install', 'claude'], '', home), text).toBe(0)
      const written = JSON.parse(readFileSync(file, 'utf8'))
      expect(written.hooks.PreToolUse, text).toHaveLength(1)
      expect(written.hooks.PreToolUse[0].hooks[0].command, text).toMatch(OWN)
    }
  })

  it('runs a copy of the build that outlives the package and keeps each build apart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const from = fakeBuild('one')
    await run(['install', 'claude'], '', home, from)
    const first = scriptOf(hookOf(join(home, '.claude/settings.json')))
    expect(readdirSync(join(first, '..')).sort()).toEqual(['chunk.mjs', 'cli.mjs'])
    rmSync(join(from, '..'), { recursive: true })
    expect(readFileSync(first, 'utf8')).toBe(`import './chunk.mjs' // one`)
    await run(['install', 'codex'], '', home, fakeBuild('one'))
    expect(hookOf(join(home, '.codex/hooks.json'))).toBe(hookOf(join(home, '.claude/settings.json')).replace('--agent claude', '--agent codex'))
    expect(scriptOf(hookOf(join(home, '.codex/hooks.json')))).toBe(first)
    await run(['install', 'claude'], '', home, fakeBuild('two'))
    const second = scriptOf(hookOf(join(home, '.claude/settings.json')))
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(true)
    expect(readdirSync(join(home, '.shell-secrets'))).toHaveLength(3)
    rmSync(second)
    await run(['install', 'claude'], '', home, fakeBuild('two'))
    expect(readFileSync(second, 'utf8')).toBe(`import './chunk.mjs' // two`)
    expect(readdirSync(join(home, '.shell-secrets'))).toHaveLength(3)
  })

  it('runs on the Node.js that installed it, falls back to PATH once that is gone, and blocks a hook that cannot start in Claude Code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const clean = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    const nodeDir = mkdtempSync(join(tmpdir(), 'ss-node-'))
    symlinkSync(process.execPath, join(nodeDir, 'node'))
    const pathBin = mkdtempSync(join(tmpdir(), 'ss-bin-'))
    writeFileSync(join(pathBin, 'node'), '#!/bin/sh\necho path >&2\nexit 1\n', { mode: 0o755 })
    const env = { HOME: home, PATH: `${pathBin}:/usr/bin:/bin` }
    const build = join(mkdtempSync(join(tmpdir(), 'ss-build-')), 'cli.mjs')
    writeFileSync(build, 'process.stdout.write(process.argv.slice(2).join(\' \'))\n')
    expect(await main(['install', 'claude'], { home, script: build, execPath: join(nodeDir, 'node') })).toBe(0)
    const hooks = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse
    expect(hooks).toHaveLength(1)
    expect(hooks[0].hooks[0].onFailure).toBe('block')
    const sh = (): { status: number | null, stdout: string, stderr: string } => {
      const ran = spawnSync('sh', ['-c', hooks[0].hooks[0].command], { input: clean, env })
      return { status: ran.status, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() }
    }
    expect(sh()).toEqual({ status: 0, stdout: 'hook --event PreToolUse --agent claude', stderr: '' })
    rmSync(join(nodeDir, 'node'))
    expect(sh()).toEqual({ status: 2, stdout: '', stderr: 'path\n' })
    await main(['install', 'codex'], { home })
    expect(JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0]).not.toHaveProperty('onFailure')
  })

  it('refuses to replace a current that is not its link, and leaves no temporary link behind', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    mkdirSync(join(home, '.shell-secrets/current'), { recursive: true })
    expect(await run(['install', 'claude'], '', home)).toBe(1)
    expect(stderr).toContain('is not the link install writes')
    expect(readdirSync(join(home, '.shell-secrets')).filter(name => name.startsWith('current'))).toEqual(['current'])
  })

  it('refuses to install from an entry that is not a build', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    expect(await run(['install', 'claude'], '', home, join(script, '../../src/cli.ts'))).toBe(1)
    expect(await run(['install', 'claude'], '', home, join(script, '../missing.mjs'))).toBe(1)
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it('blocks the hook and refuses to install on a Node.js older than 22', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    const clean = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(await main(['hook'], { home, stdin: () => clean, node: 'v20.20.2' })).toBe(2)
    expect(stderr).toContain('Node.js 22 or later')
    const reply = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '```bash\nexport API_KEY=<your-key>\n```' })
    expect(await main(['hook'], { home, stdin: () => reply, node: 'v20.20.2' })).toBe(0)
    expect(stdout).toBe('')
    expect(await main(['install', 'claude'], { home, node: 'v18.20.6' })).toBe(1)
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(await main(['hook'], { home, stdin: () => clean, node: 'node' })).toBe(2)
    expect(await main(['hook'], { home, stdin: () => clean, node: 'v22.13.1' })).toBe(0)
    await main(['install', 'claude'], { home, node: 'v22.13.1' })
    expect(await main(['uninstall', 'claude'], { home, node: 'v20.20.2' })).toBe(0)
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks).toEqual({})
  })

  it('writes the Codex matcher to hooks.json and says to trust the hook', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-'))
    await run(['install', 'codex'], '', home)
    expect(stdout).toContain('Codex runs a new hook only after you trust it: open /hooks in Codex once.')
    const entry = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash|apply_patch')
    expect(entry.hooks[0].timeout).toBe(HOOK_TIMEOUT_S)
  })

  it('stops its own git and file work well inside the hook timeout', () => {
    expect(plugin.timeout).toBe(HOOK_TIMEOUT_S)
    expect(TIME_BUDGET_MS).toBeLessThan(HOOK_TIMEOUT_S * 1000)
  })

  describe('a credential slot', () => {
    const stop = async (fields: Record<string, unknown>): Promise<{ code: number, out: string }> => {
      const code = await await run(['hook'], JSON.stringify({ hook_event_name: 'Stop', cwd: '/', ...fields }))
      return { code, out: stdout }
    }

    it('blocks a Bash call that would send the stand-in itself, and says what to write instead', async () => {
      expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.github.com/user' } }))).toBe(2)
      const message = stderr
      expect(message).toContain('Authorization: Bearer <YOUR_TOKEN>')
      expect(message).toContain('$(gh auth token)')
      expect(message).toContain('! gh auth login')
    })

    it('lets a Bash call through whose slot sits in a heredoc body', async () => {
      const command = 'gh pr create --body-file - <<\'EOF\'\nno more export API_KEY=<your-key>\nEOF'
      expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))).toBe(0)
    })

    it('reports a live secret before a slot in the same call', async () => {
      expect(await run(['hook'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: `export T=${fake.github()} K=<your-key>` } }))).toBe(2)
      expect(stderr).toContain('GitHub token')
    })

    it('sends back a reply that hands the user a slot, as JSON on stdout with exit 0', async () => {
      const { code, out } = await stop({ stop_hook_active: false, last_assistant_message: '```bash\nexport API_KEY=<your-key>\n```' })
      expect(code).toBe(0)
      const answer = JSON.parse(out)
      expect(answer.decision).toBe('block')
      expect(answer.reason).toContain('API_KEY=<your-key>')
      expect(answer.reason).toContain('! gh auth login')
    })

    it('lets the reply stand once a Stop hook has already sent it back', async () => {
      expect(await stop({ stop_hook_active: true, last_assistant_message: '```bash\nexport API_KEY=<your-key>\n```' })).toEqual({ code: 0, out: '' })
    })

    it('lets a clean reply, prose about a slot, and a missing message stand', async () => {
      expect(await stop({ last_assistant_message: 'Done: `gh api user` works.' })).toEqual({ code: 0, out: '' })
      expect(await stop({ last_assistant_message: 'No more `export KEY=<your-key>` slots.' })).toEqual({ code: 0, out: '' })
      expect(await stop({ last_assistant_message: null })).toEqual({ code: 0, out: '' })
      expect(await stop({})).toEqual({ code: 0, out: '' })
    })
  })

  describe('the Stop entry', () => {
    const read = (file: string): Record<string, unknown[]> => JSON.parse(readFileSync(file, 'utf8')).hooks

    it('is written once next to the PreToolUse one, without a matcher, and removed by uninstall', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const file = join(home, '.claude/settings.json')
      const other = { hooks: [{ type: 'command', command: 'say done' }] }
      mkdirSync(join(home, '.claude'))
      writeFileSync(file, JSON.stringify({ hooks: { Stop: [other] } }))
      await run(['install', 'claude'], '', home)
      await run(['install', 'claude'], '', home)
      const stop = read(file).Stop!
      expect(stop).toHaveLength(2)
      expect(stop[0]).toEqual(other)
      expect(stop[1]).toEqual({ hooks: [{ type: 'command', command: expect.stringMatching(/^n='.+'; \[ -x "\$n" \] \|\| n=node; "\$n" '.+\/\.shell-secrets\/current\/cli\.mjs' hook --event Stop --agent claude$/), timeout: 10, statusMessage: 'Checking the reply for credential slots' }] })
      expect(read(file).PreToolUse).toHaveLength(1)
      await run(['uninstall', 'claude'], '', home)
      expect(read(file).Stop).toEqual([other])
    })

    it('replaces the 0.2.1 PreToolUse entry from a checkout not named shell-secrets, and adds one Stop entry', async () => {
      for (const path of ['/home/me/code/my-shell-secrets/dist/cli.mjs', '/home/me/code/shell-secrets-fork/dist/cli.mjs']) {
        const home = mkdtempSync(join(tmpdir(), 'ss-'))
        const file = join(home, '.claude/settings.json')
        mkdirSync(join(home, '.claude'))
        writeFileSync(file, JSON.stringify({ hooks: {
          PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node '${path}' hook || exit 2`, timeout: 10, statusMessage: 'Scanning for secrets' }] }],
        } }))
        expect(await run(['install', 'claude'], '', home)).toBe(0)
        const { PreToolUse, Stop } = read(file) as Record<string, { hooks: { command: string }[] }[]>
        expect(PreToolUse!.map(e => e.hooks[0]!.command)).toEqual([expect.stringMatching(OWN)])
        expect(Stop!.map(e => e.hooks[0]!.command)).toEqual([expect.stringMatching(/\/\.shell-secrets\/current\/cli\.mjs' hook --event Stop --agent claude$/)])
      }
    })

    it('replaces the entries main\'s Stop-hook install wrote, leaving exactly one Stop entry, the one install writes now', async () => {
      const forms = [
        { at: (home: string) => join(home, '.claude/settings.json'), args: ['claude'], current: (home: string) => `n='/usr/bin/node'; [ -x "$n" ] || n=node; "$n" '${home}/.shell-secrets/current/cli.mjs' hook` },
        { at: (home: string) => join(home, '.codex/hooks.json'), args: ['codex', '--project'], current: () => 'npx --no-install shell-secrets hook' },
      ]
      for (const { at, args, current } of forms) {
        const home = mkdtempSync(join(tmpdir(), 'ss-'))
        const file = at(home)
        const entry = (command: string, matcher?: string): object => ({ ...matcher ? { matcher } : {}, hooks: [{ type: 'command', command, timeout: 10 }] })
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, JSON.stringify({ hooks: {
          PreToolUse: [entry(`${current(home)} || exit 2`, 'Bash|Write|Edit|MultiEdit|NotebookEdit')],
          Stop: [entry('say done'), entry(current(home))],
        } }))
        expect(await run(['install', ...args], '', home)).toBe(0)
        const { PreToolUse, Stop } = read(file) as Record<string, { hooks: { command: string, statusMessage?: string }[] }[]>
        expect(PreToolUse).toHaveLength(1)
        expect(Stop!.map(e => e.hooks[0]!.command)).toEqual(['say done', expect.stringMatching(/ hook --event Stop --agent (?:claude|codex)$/)])
        expect(Stop![1]!.hooks[0]!.statusMessage).toBe('Checking the reply for credential slots')
        expect(await run(['uninstall', ...args], '', home)).toBe(0)
        expect(read(file)).toEqual({ Stop: [entry('say done')] })
      }
    })

    it('lets the agent stop when the hook cannot start, while PreToolUse still blocks', async () => {
      const commands = (file: string): Record<string, string> => Object.fromEntries(Object.entries(read(file) as Record<string, { hooks: { command: string }[] }[]>).map(([event, entries]) => [event, entries[0]!.hooks[0]!.command]))
      const exit = (command: string): number | null => spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' } }).status
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      await run(['install', 'claude'], '', home)
      await run(['install', 'codex', '--project'], '', home)
      rmSync(join(home, '.shell-secrets'), { recursive: true })
      for (const file of [join(home, '.claude/settings.json'), join(home, '.codex/hooks.json')]) {
        const { PreToolUse, Stop } = commands(file)
        expect(exit(PreToolUse!), PreToolUse).toBe(2)
        expect(exit(Stop!), Stop).not.toBe(2)
        expect(exit(Stop!), Stop).not.toBe(0)
      }
      await run(['uninstall', 'codex', '--project'], '', home)
      expect(read(join(home, '.codex/hooks.json'))).toEqual({})
    })
  })

  describe('a payload that arrives cut short', () => {
    it('lets the agent stop through the installed Stop command, while the PreToolUse one blocks', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      await run(['install', 'claude'], '', home, join(import.meta.dirname, '../../dist/cli.mjs'))
      const hooks = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>
      const sh = (command: string, input: string) => spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8' })
      const stop = sh(hooks.Stop![0]!.hooks[0]!.command, '{"hook_event_name":"Stop","last_assistant_message":"export API_KEY=<your')
      expect(stop.status, stop.stderr).toBe(0)
      expect(stop.stdout).toBe('')
      expect(sh(hooks.PreToolUse![0]!.hooks[0]!.command, '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_in').status).toBe(2)
    })
  })

  describe('the credential-handling skill', () => {
    const skill = (base: string, dir: string): string => join(base, dir, 'credential-handling/SKILL.md')

    it('is installed for Claude Code and Codex, kept current, and removed by uninstall', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const shipped = readFileSync(join(skills, 'credential-handling/SKILL.md'), 'utf8')
      for (const [agent, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills']] as const) {
        expect(await run(['install', agent], '', home)).toBe(0)
        expect(stdout).toContain(`Installed the credential-handling skill in ${join(home, dir, 'credential-handling')}`)
        expect(readFileSync(skill(home, dir), 'utf8')).toBe(shipped)
        writeFileSync(skill(home, dir), 'stale')
        expect(await run(['install', agent], '', home)).toBe(0)
        expect(readFileSync(skill(home, dir), 'utf8')).toBe(shipped)
        expect(existsSync(join(home, dir, 'credential-handling/references/where-credentials-live.md'))).toBe(true)
        expect(await run(['uninstall', agent], '', home)).toBe(0)
        expect(existsSync(join(home, dir, 'credential-handling'))).toBe(false)
      }
    })

    it('goes into the project with --project', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const project = mkdtempSync(join(tmpdir(), 'ss-project-'))
      await run(['install', 'claude', '--project'], '', home, script, project)
      expect(existsSync(skill(project, '.claude/skills'))).toBe(true)
      expect(existsSync(skill(home, '.claude/skills'))).toBe(false)
      await run(['uninstall', 'claude', '--project'], '', home, script, project)
      expect(existsSync(join(project, '.claude/skills/credential-handling'))).toBe(false)
    })

    it('leaves a skill of the same name it did not install, and still installs the hook', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      mkdirSync(join(home, '.claude/skills/credential-handling'), { recursive: true })
      writeFileSync(skill(home, '.claude/skills'), 'mine')
      expect(await run(['install', 'claude'], '', home)).toBe(0)
      expect(stderr).toContain('credential-handling')
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe('mine')
      expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse).toHaveLength(1)
      expect(await run(['uninstall', 'claude'], '', home)).toBe(0)
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe('mine')
    })

    it('writes no hook when the skill cannot be installed', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      expect(await main(['install', 'claude'], { home }, shellSecrets(join(home, 'missing')))).toBe(1)
      expect(stderr).toContain('holds no skill to install')
      expect(existsSync(join(home, '.claude/settings.json'))).toBe(false)
      const file = join(home, '.claude/settings.json')
      const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude/skills'), 'not a directory')
      writeFileSync(file, before)
      expect(await run(['install', 'claude'], '', home)).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe(before)
    })

    it('leaves the hook on the build it ran before when the skill step fails', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const current = join(home, '.shell-secrets/current')
      expect(await run(['install', 'claude'], '', home)).toBe(0)
      const installed = readlinkSync(current)
      const settings = readFileSync(join(home, '.claude/settings.json'), 'utf8')
      rmSync(join(home, '.claude/skills'), { recursive: true })
      writeFileSync(join(home, '.claude/skills'), 'not a directory')
      expect(await run(['install', 'claude'], '', home, fakeBuild('next'))).toBe(1)
      expect(stderr).toContain('.claude/skills')
      expect(readlinkSync(current)).toBe(installed)
      expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe(settings)
    })

    it('stages the copy beside a directory of the staging name without touching it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const neighbour = join(home, '.claude/skills', `credential-handling.${process.pid}`)
      mkdirSync(neighbour, { recursive: true })
      writeFileSync(join(neighbour, 'notes.md'), 'mine')
      expect(await run(['install', 'claude'], '', home)).toBe(0)
      expect(readFileSync(join(neighbour, 'notes.md'), 'utf8')).toBe('mine')
      expect(readFileSync(skill(home, '.claude/skills'), 'utf8')).toBe(readFileSync(join(skills, 'credential-handling/SKILL.md'), 'utf8'))
    })

    it('leaves a link in its place alone', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ss-'))
      const elsewhere = mkdtempSync(join(tmpdir(), 'ss-elsewhere-'))
      writeFileSync(join(elsewhere, 'SKILL.md'), 'mine')
      mkdirSync(join(home, '.claude/skills'), { recursive: true })
      symlinkSync(elsewhere, join(home, '.claude/skills/credential-handling'))
      await run(['install', 'claude'], '', home)
      await run(['uninstall', 'claude'], '', home)
      expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('mine')
      expect(existsSync(skill(home, '.claude/skills'))).toBe(true)
    })
  })
})
