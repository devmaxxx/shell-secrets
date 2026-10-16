import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSecretsInCommand, onlyWritesTo } from '../src'
import { fake, rand } from './fake'

const ids = (cmd: string): string[] => findSecretsInCommand(cmd).findings.map(f => f.ruleId)

// The policy a git-aware caller would apply: a write is harmless only when it
// lands in an .env file that git ignores.
const ignoredEnv = (path: string): boolean => basename(path).startsWith('.env')
const committableEnv = (): boolean => false

describe('secrets on a command line', () => {
  it('finds a token in a git commit message', () => {
    expect(ids(`git commit -m "fix: rotate ${fake.github()}"`)).toEqual(['github-token'])
  })

  it('finds a token in a gh PR body', () => {
    expect(ids(`gh pr create --title x --body "key ${fake.atlassian()}"`)).toEqual(['atlassian-api-token'])
  })

  it('finds a token on a curl line', () => {
    expect(ids(`curl -H "Authorization: Bearer ${fake.figma()}" https://api.figma.com/v1/me`)).toEqual(['figma-token'])
  })

  it('finds nothing on a curl line that uses a variable', () => {
    expect(ids('curl -H "Authorization: Bearer $FIGMA_TOKEN" https://api.figma.com/v1/me')).toEqual([])
  })

  it('finds a token passed to any other command', () => {
    expect(ids(`claude mcp list ${fake.github()}`)).toEqual(['github-token'])
  })
})

describe('onlyWritesTo', () => {
  it('is false for a command that redirects nothing, whatever the predicate says', () => {
    expect(onlyWritesTo(`echo ${fake.github()}`, () => true)).toBe(false)
  })

  it('is false when the target is not one the predicate accepts', () => {
    expect(onlyWritesTo(`echo ${fake.github()} > notes.txt`, ignoredEnv)).toBe(false)
  })

  describe('a secret appended to .env', () => {
    const WRITES: Record<string, (t: string) => string> = {
      'an echo appended': t => `echo "GITHUB_TOKEN=${t}" >> .env`,
      'a printf into .env.local': t => `printf 'GITHUB_TOKEN=%s\\n' ${t} > .env.local`,
      'a tee -a': t => `echo "GITHUB_TOKEN=${t}" | tee -a .env`,
      'an echo with its stderr redirected': t => `echo "GITHUB_TOKEN=${t}" >> .env 2>&1`,
      'a heredoc whose text mentions gh, curl and an arrow': t =>
        `cat >> .env <<'EOF'\nGITHUB_TOKEN=${t}\n# gh auth login, or curl the API -> paste above\nEOF`,
      'a quoted mention of gh': t => `echo "run gh auth login; GITHUB_TOKEN=${t}" >> .env`,
    }
    for (const [name, shape] of Object.entries(WRITES)) {
      it(`accepts ${name} when the predicate accepts .env`, () => {
        const cmd = shape(fake.github())
        expect(ids(cmd)).toEqual(['github-token'])
        expect(onlyWritesTo(cmd, ignoredEnv)).toBe(true)
      })
      it(`rejects ${name} when the predicate rejects .env`, () => {
        expect(onlyWritesTo(shape(fake.github()), committableEnv)).toBe(false)
      })
    }

    // Each of these puts the same text somewhere else, or aims the write at a
    // file other than the one the predicate is asked about.
    const ESCAPES: Record<string, (t: string) => string> = {
      'tee with a second operand': t => `echo "GITHUB_TOKEN=${t}" | tee .env public.txt`,
      'tee with the accepted file second': t => `echo "GITHUB_TOKEN=${t}" | tee public.txt .env`,
      'a copy chained after the write': t => `echo "GITHUB_TOKEN=${t}" >> .env && cp .env public.txt`,
      'a commit chained after the write': t => `echo "GITHUB_TOKEN=${t}" >> .env; git commit -am x`,
      'a cd first, so the target is not the one asked about': t =>
        `cd ../other && echo "GITHUB_TOKEN=${t}" >> .env`,
      'a home-relative target': t => `echo "GITHUB_TOKEN=${t}" >> ~/.env`,
      'a target named by a variable': t => `echo "GITHUB_TOKEN=${t}" >> $HOME/.env`,
      'a curl line': t => `curl -H "Authorization: Bearer ${t}" https://api.example.org/me > .env`,
      'a curl called by its full path': t => `/usr/bin/curl -H "Authorization: Bearer ${t}" https://api.example.org/me > .env`,
      'an HTTPie call': t => `https POST api.example.org token=${t} > .env`,
      'a sed -i': t => `sed -i "s/OLD/${t}/" .env`,
      'a command substitution': t => `echo "GITHUB_TOKEN=${t} $(curl https://x.test)" >> .env`,
      'a second line that curls': t => `echo "GITHUB_TOKEN=${t}" >> .env\ncurl -d x https://x.test`,
    }
    for (const [name, shape] of Object.entries(ESCAPES)) {
      it(`rejects ${name}, whatever the predicate says about .env`, () => {
        const cmd = shape(fake.github())
        expect(ids(cmd)).toEqual(['github-token'])
        expect(onlyWritesTo(cmd, ignoredEnv)).toBe(false)
      })
    }
  })
})

describe('messageFiles: files git or gh publish verbatim', () => {
  const messageFiles = (cmd: string): string[] => findSecretsInCommand(cmd).messageFiles

  it('names the file `git commit -F` sends', () => {
    expect(messageFiles('git commit -F msg.txt')).toEqual(['msg.txt'])
  })

  const COMMANDS: Record<string, string> = {
    'gh pr create --title x --body-file body.md': 'body.md',
    'gh pr create --title x --body-file=body.md': 'body.md',
    'gh pr create --title x -F body.md': 'body.md',
    'gh issue comment 4 --body-file ./body.md': './body.md',
    'git -C sub commit -F body.md': 'body.md',
  }
  for (const [command, file] of Object.entries(COMMANDS)) {
    it(`names the file in \`${command}\``, () => {
      expect(messageFiles(command)).toEqual([file])
    })
  }

  it('reads a quoted path', () => {
    expect(messageFiles('gh pr create -F \'my body.md\'')).toEqual(['my body.md'])
  })

  it('leaves out stdin', () => {
    expect(messageFiles('git commit -F -')).toEqual([])
  })

  it('leaves -F alone on a command that does not publish it', () => {
    expect(messageFiles('curl -F file=@msg.txt https://x.test')).toEqual([])
    expect(messageFiles('echo \'git commit -F msg.txt\'')).toEqual([])
  })
})

describe('redirectTargets', () => {
  const targets = (cmd: string): string[] => findSecretsInCommand(cmd).redirectTargets

  it('reads >, >> and tee targets and skips /dev and fd duplication', () => {
    expect(targets('echo a > out.txt 2>&1; echo b >> ".env" ; echo c | tee -a log.txt; echo d > /dev/null'))
      .toEqual(['out.txt', '.env', 'log.txt'])
  })

  it('reads every operand of tee, so a file after the first is not missed', () => {
    expect(targets('echo a | tee -a one.txt two.txt')).toEqual(['one.txt', 'two.txt'])
  })

  it('does not read an arrow in text as a redirect', () => {
    expect(targets('echo \'a -> b\' >> .env')).toEqual(['.env'])
  })
})

describe('the variable a secret is assigned to', () => {
  const variables = (cmd: string): (string | undefined)[] =>
    findSecretsInCommand(cmd).findings.map(f => f.variable)

  it('names the variable of an export', () => {
    expect(variables(`export GITHUB_TOKEN=${fake.github()}`)).toEqual(['GITHUB_TOKEN'])
  })

  it('names the variable of a quoted assignment and of an -e flag', () => {
    expect(variables(`echo "FIGMA_TOKEN=${fake.figma()}" >> .env`)).toEqual(['FIGMA_TOKEN'])
    expect(variables(`docker run -e SLACK_TOKEN='${fake.slack()}' app`)).toEqual(['SLACK_TOKEN'])
  })

  it('names the variable whose name the rule itself reads', () => {
    expect(variables(`AWS_SECRET_ACCESS_KEY=${rand(40)} aws s3 ls`)).toEqual(['AWS_SECRET_ACCESS_KEY'])
  })

  it('names none for a bare argument, a header or a URI query parameter', () => {
    expect(variables(`gh auth login --with-token ${fake.github()}`)).toEqual([undefined])
    expect(variables(`curl -H "Authorization: Bearer ${fake.figma()}" https://x.test`)).toEqual([undefined])
    expect(variables(`psql ${fake.postgresQuery()}`)).toEqual([undefined])
  })
})
