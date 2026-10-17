<div align="center">

# shell-secrets

**Catch a secret in a shell command or an AI-agent tool call before it runs — written to a file, exported, or put in a commit message. Zero dependencies.**

[![npm version](https://img.shields.io/npm/v/shell-secrets?color=cb3837)](https://www.npmjs.com/package/shell-secrets)
[![npm downloads](https://img.shields.io/npm/dm/shell-secrets)](https://www.npmjs.com/package/shell-secrets)
[![CI](https://github.com/devmaxxx/shell-secrets/actions/workflows/ci.yml/badge.svg)](https://github.com/devmaxxx/shell-secrets/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/shell-secrets)](https://www.npmjs.com/package/shell-secrets)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![bundle size](https://img.shields.io/bundlejs/size/shell-secrets)](https://bundlejs.com/?q=shell-secrets)
[![license: MIT](https://img.shields.io/npm/l/shell-secrets)](./LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Detected secrets](#detected-secrets) · [API](#api) · [Recipes](#recipes) · [Compared](#compared-with-other-scanners)

</div>

<p align="center">
  <img src="./demo/demo.gif" alt="The shell-secrets hook blocks a Bash call that writes a GitHub token into config.js and lets the same write through $GITHUB_TOKEN pass" width="800">
</p>

The [agent hook](#block-secrets-in-ai-agent-tool-calls) run on two tool calls; the token is a fake. Regenerate with `pnpm build && vhs demo/demo.tape`.

<details>
<summary><b>Table of contents</b></summary>

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Detected secrets](#detected-secrets)
- [API](#api)
  - [`findSecrets`](#findsecretstext-options)
  - [`findNewSecrets`](#findnewsecretsbefore-after-options)
  - [`findSecretsInCommand`](#findsecretsincommandcmd-options)
  - [`onlyWritesTo`](#onlywritestocmd-accept)
  - [Custom and disabled rules](#custom-and-disabled-rules)
- [Recipes](#recipes)
- [Compared with other scanners](#compared-with-other-scanners)
- [Limits](#limits)
- [Contributing](#contributing)
- [License](#license)

</details>

## Why

Coding agents and CI bots run shell commands, and that is where secrets leak now: `echo "$KEY" > config.js`, `export GITHUB_TOKEN=ghp_…` landing in a transcript, a token pasted into the message file of `git commit -F msg.txt`. Repository scanners like gitleaks and secretlint catch it after the fact, in files and history. Generic string scanners see the token but not what the command does with it.

`findSecretsInCommand` reads the command the way the shell would: it reports each secret, the variable it is exported or assigned to, the files the command writes through `>`, `>>` or `tee`, and the message files `git` / `gh` would publish. It is a plain JavaScript function with no dependencies, so it fits in a pre-tool-use hook. It returns where the secret is and a masked preview, never the secret itself. `findSecrets` does the same for any plain string — a log line, a prompt, a staged diff.

## Features

- **Reads shell commands.** `findSecretsInCommand` reports secrets assigned or exported (`NAME=secret`), the files a command writes through `>`, `>>` or `tee`, and the message files `git` / `gh` would publish.
- **Built for agent tool calls.** `onlyWritesTo` answers "does this command only write the secret into an allowed file, such as a gitignored `.env`?".
- **Zero runtime dependencies.** ESM, fully typed, about 12 kB gzipped.
- **Tuned for precision.** Placeholders (`ghp_xxxx…`, `<token>`, `example`), variable references (`${DB_PASSWORD}`) and local dev credentials (`postgres:postgres@localhost`) are not reported, so a hit is worth stopping for. Classic GitHub tokens must carry a valid CRC32 checksum, so made-up ones in docs and tests pass.
- **Sees through base64.** A blob that decodes to text, such as a Kubernetes Secret value or an `echo … | base64 -d`, is decoded and scanned, nested encodings included; the finding spans the encoded text.
- **Catches unnamed secrets too.** A value under a secret-sounding name (`API_TOKEN=…`, `client_secret: "…"`, `--api-key …`) is reported when a statistical test reads it as machine-generated, not a word, identifier, path or UUID.
- **Safe to log.** A finding holds the rule, the offsets and a redacted preview such as `ghp_********`. It never holds the value.
- **Diff-aware.** `findNewSecrets` reports only what an edit adds, not secrets the text already had.
- **Extensible.** Add your own rules or drop built-in ones with a plain array.
- **Linear time on hostile input**, so it can run on every prompt, keystroke or commit.

## Install

```sh
npm install shell-secrets
pnpm add shell-secrets
yarn add shell-secrets
bun add shell-secrets
```

Requires Node.js 22 or later.

## Quick start

```ts
import { findSecrets } from 'shell-secrets'

const token = `ghp_${'aBcDeFgHiJkLmNoPqRsTuVwXyZ9876543210'}` // fake, split so this README scans clean
const log = `curl -H "Authorization: token ${token}" https://api.github.com/user`

findSecrets(log)
// [{ ruleId: 'github-token', name: 'GitHub token', env: 'GITHUB_TOKEN',
//    start: 30, end: 70, preview: 'ghp_********' }]

findSecrets('GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') // [] (placeholder)
findSecrets('postgres://app:$PG_PASSWORD@db.prod.internal/app') // [] (variable reference)
```

`log.slice(start, end)` is the secret, if you need to act on it. The finding itself is safe to print.

## Detected secrets

| Rule id | Provider | Example shape | Suggested variable |
| --- | --- | --- | --- |
| `github-token` | GitHub classic token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) | `ghp_••••` (36+ alphanumerics) | `GITHUB_TOKEN` |
| `github-fine-grained-token` | GitHub fine-grained token | `github_pat_••••` (40+ chars) | `GITHUB_TOKEN` |
| `atlassian-api-token` | Atlassian API token, Bitbucket access token | `ATATT3••••`, `ATCTT3••••` | `ATLASSIAN_API_TOKEN` |
| `figma-token` | Figma personal access token | `figd_••••` | `FIGMA_TOKEN` |
| `slack-token` | Slack bot, user, app, refresh token | `xoxb-••••`, `xapp-••••` | `SLACK_TOKEN` |
| `slack-webhook-url` | Slack incoming webhook | `https://hooks.slack.com/services/T••••/B••••/••••` | `SLACK_WEBHOOK_URL` |
| `anthropic-api-key` | Anthropic | `sk-ant-••••` | `ANTHROPIC_API_KEY` |
| `openai-api-key` | OpenAI (`sk-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-`) | `sk-proj-••••` | `OPENAI_API_KEY` |
| `google-api-key` | Google API key (Gemini, Maps, Firebase) | `AIza••••` (39 chars) | `GOOGLE_API_KEY` |
| `google-oauth-client-secret` | Google OAuth client secret | `GOCSPX-••••` | `GOOGLE_CLIENT_SECRET` |
| `groq-api-key` | Groq | `gsk_••••` | `GROQ_API_KEY` |
| `xai-api-key` | xAI | `xai-••••` | `XAI_API_KEY` |
| `huggingface-token` | Hugging Face | `hf_••••` | `HF_TOKEN` |
| `gitlab-token` | GitLab personal, deploy, trigger, runner, OAuth token | `glpat-••••` | `GITLAB_TOKEN` |
| `npm-token` | npm access token | `npm_••••` (36 chars) | `NPM_TOKEN` |
| `pypi-token` | PyPI API token | `pypi-AgEIcHlwaS5vcmc••••` | `PYPI_API_TOKEN` |
| `stripe-secret-key` | Stripe live secret or restricted key (test mode is ignored) | `sk_live_••••`, `rk_live_••••` | `STRIPE_SECRET_KEY` |
| `stripe-webhook-secret` | Stripe webhook signing secret | `whsec_••••` | `STRIPE_WEBHOOK_SECRET` |
| `sendgrid-api-key` | SendGrid | `SG.••••.••••` | `SENDGRID_API_KEY` |
| `linear-api-key` | Linear | `lin_api_••••` | `LINEAR_API_KEY` |
| `shopify-token` | Shopify access token | `shpat_••••` | `SHOPIFY_ACCESS_TOKEN` |
| `digitalocean-token` | DigitalOcean personal, OAuth, refresh token | `dop_v1_••••` | `DIGITALOCEAN_TOKEN` |
| `discord-webhook-url` | Discord webhook | `https://discord.com/api/webhooks/••••/••••` | `DISCORD_WEBHOOK_URL` |
| `aws-access-key` | AWS access key ID, long-lived or temporary | `AKIA••••`, `ASIA••••` (20 chars) | `AWS_ACCESS_KEY_ID` |
| `aws-secret-key` | AWS secret access key or session token, read off its name | `aws_secret_access_key = ••••` | `AWS_SECRET_ACCESS_KEY` |
| `private-key` | PEM / PGP private key with a body, encrypted or inside a JSON string | `-----BEGIN … PRIVATE KEY-----` + body | — |
| `age-secret-key` | age encryption identity | `AGE-SECRET-KEY-1••••` | — |
| `database-uri-password` | MongoDB, PostgreSQL, MySQL, MariaDB, Redis, AMQP URI | `postgres://user:<password>@host` | `DATABASE_URL` |
| `database-uri-query-password` | libpq / JDBC URI | `jdbc:postgresql://host/db?password=<password>` | `DATABASE_URL` |
| `telegram-bot-token` | Telegram bot, also inside a Bot API URL | `123456789:••••` | `TELEGRAM_BOT_TOKEN` |
| `jwt` | JSON Web Token of 150+ characters | `eyJ••••.eyJ••••.••••` | — |
| `sentry-token` | Sentry organization or user auth token | `sntrys_eyJ••••`, `sntryu_••••` | `SENTRY_AUTH_TOKEN` |
| `databricks-token` | Databricks personal access token | `dapi••••` (32 hex) | `DATABRICKS_TOKEN` |
| `onepassword-service-account-token` | 1Password service account, body checked to be base64 JSON | `ops_eyJ••••` | `OP_SERVICE_ACCOUNT_TOKEN` |
| `url-password` | Password in any other URL, to a host that resolves | `https://user:<password>@host.tld` | — |
| `authorization-header` | Bearer, Basic or token credential in an `Authorization` header | `Authorization: Bearer ••••` | — |
| `curl-user-password` | Password passed to `curl -u` | `curl -u user:<password>` | — |
| `generic-secret` | Random-looking value under a secret-sounding name | `API_TOKEN=••••`, `--api-key ••••` | — |

The last four are fallbacks: where one overlaps a provider rule's finding, only the provider's is reported. `generic-secret` judges the value with the randomness test from [ripsecrets](https://github.com/sirwart/ripsecrets) (distinct characters, character-class balance and common bigrams) and drops runs of the alphabet, UUIDs, member paths such as `process.env.TOKEN`, file paths and names that hold a hash or public key.

For URIs, AWS secret keys and Telegram tokens the finding spans only the secret part, not the user, host or variable name.

## API

### `findSecrets(text, options?)`

Returns every live-looking secret in `text` as a `Finding[]`, ordered by position. An empty or non-string input returns `[]`.

```ts
interface Finding {
  ruleId: string // 'github-token'
  name: string // 'GitHub token'
  env: string | null // 'GITHUB_TOKEN': the variable to suggest instead
  start: number // text.slice(start, end) is the secret
  end: number
  preview: string // 'ghp_********'; values under 20 characters show no prefix
}
```

Offsets are UTF-16 code units, as with `String.prototype.slice`.

### `findNewSecrets(before, after, options?)`

The secrets in `after` that `before` does not already contain. Use it for an edit or a diff, where keeping an existing secret as context writes nothing new. Offsets refer to `after`.

```ts
findNewSecrets(oldFileContents, newFileContents)
```

### `findSecretsInCommand(cmd, options?)`

Scans a shell command line and returns a `CommandScan`:

```ts
interface CommandScan {
  findings: CommandFinding[] // Finding plus `variable` when the secret is assigned (NAME=secret)
  redirectTargets: string[] // files written through >, >> or tee, unexpanded
  messageFiles: string[] // files git or gh publish verbatim (commit -F, --body-file, a stdin source, add -f, gh uploads)
  unresolvedSources: string[] // what it publishes that no file name pins down; treat as unscanned
}
```

```ts
findSecretsInCommand(`export GITHUB_TOKEN=${token} && git commit -F msg.txt > out.log`)
// { findings: [{ ruleId: 'github-token', variable: 'GITHUB_TOKEN', preview: 'ghp_********', … }],
//   redirectTargets: ['out.log'],
//   messageFiles: ['msg.txt'],
//   unresolvedSources: [] }
```

The scanner cannot read `messageFiles`; pass their contents to `findSecrets` yourself. A file the command first writes from literal text (`echo`, `printf`, a heredoc that does not expand, a `tee` fed by one) is left out, since that text is already in the command; one that any other command names first, such as `cp .env msg`, is unresolved, since what is on disk now is not what gets published. `git add -f -A` lists `.`, and a forced add can name a directory: give `checkToolCall` a `listIgnored` in its `GuardEnv` to scan the ignored files under it, which the hook does through `git ls-files` up to 2000 files. `gh gist create`, `gh release create` / `upload` assets, `gh api --input` and `gh api -F key=@file` are read as published files too. The command is found by name however it is quoted or wrapped (`'git'`, `\git`, `nice`, `timeout`), and shell code run through `bash -c`, `eval` or a heredoc fed to a shell is read the same way. `unresolvedSources` holds what it cannot pin to a file: `git add --pathspec-from-file`, a `--body-file -` fed by a stage other than `cat`, `head` or `tail`, a relative path after `cd` or under `git -C`, a file the command fills any other way, arguments built by `xargs`, a message built by a command or process substitution (`-m "$(cat .env)"`, `-F <(…)`) other than a literal `$(cat <<'EOF' … EOF)` or `$(echo …)`, and a command over 100,000 characters.

### `onlyWritesTo(cmd, accept)`

`true` when the command's whole effect is writing to files and `accept(path)` approves every target — for example, "a secret may go into a gitignored `.env`, nowhere else".

```ts
onlyWritesTo(`echo "GITHUB_TOKEN=${token}" >> .env`, path => path === '.env') // true
```

Only a lone `echo`, `printf` or `cat` with `>`, `>>` or `| tee` qualifies. A chained, substituted or otherwise piped command never does, nor does a target containing `~`, `$`, a glob or a backtick; `accept` is not called for those.

### `checkToolCall(call, env, options?)`

The secrets an agent's tool call would leak. `call` is `{ kind: 'shell', command }`, `{ kind: 'write', path, content }`, `{ kind: 'edit', path, before, after }` or `{ kind: 'patch', patch }` (Codex `apply_patch`). `env.isIgnored(path)` says whether a file may hold a secret; `env.readFile(path)` returns a file's text or `null`. Writes into ignored files and secrets an edit only keeps return nothing.

### `defaultRules`

The frozen, ordered list of built-in `Rule`s from the table above.

### Types

`Finding`, `CommandFinding`, `CommandScan`, `Rule` and `ScanOptions` (`{ rules?: readonly Rule[] }`) are exported as types.

### Custom and disabled rules

Every function takes `{ rules }`. Filter `defaultRules` to disable one, spread it to add your own:

```ts
import type { Rule } from 'shell-secrets'
import { defaultRules, findSecrets } from 'shell-secrets'

const acme: Rule = {
  id: 'acme-key',
  name: 'Acme API key',
  env: 'ACME_KEY',
  pattern: /acme_live_([A-Za-z0-9]{24})/, // `g` and `d` are added for you
  secretGroup: 1, // the capture group that is the secret; defaults to the whole match
}

const rules = [...defaultRules.filter(r => r.id !== 'jwt'), acme]
findSecrets(text, { rules })
```

A rule may also set:

- `ignore(match)` to drop a match outright;
- `placeholders: false` to skip the shared placeholder test;
- `fallback: true` to report a match only where no specific rule already did;
- `prepare(text)` to rewrite the text before matching. It must return a string of the same length, or `findSecrets` throws, because offsets would no longer point at the original text.

## Recipes

### Block secrets in AI-agent tool calls

The `shell-secrets` command installs a `PreToolUse` hook for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/hooks) (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) or [Codex](https://developers.openai.com/codex/hooks) (`Bash`, `apply_patch`). It blocks a call that carries a new secret with exit code 2, which shows the masked finding to the agent.

```sh
npx shell-secrets install claude   # ~/.claude/settings.json
npx shell-secrets install codex    # ~/.codex/hooks.json; then trust it once in /hooks
npx shell-secrets install claude --project   # .claude/settings.json, runs the repo's devDependency
npx shell-secrets uninstall claude
```

Installing again replaces the earlier entry and leaves other hooks alone. A project install runs `npx --no-install shell-secrets hook || exit 2`, so add the package as a devDependency there; without it the hook blocks every call rather than letting them run unchecked.

A secret is let through when it only lands in a file git ignores and does not track, such as `.env`: `echo "TOKEN=..." >> .env` passes, `... >> .env; cp .env config.js` does not, and neither does a write to an ignored name that is a symbolic or hard link. The files `git commit -F` and `gh --body-file` publish are scanned too, including one fed to `-F -` through `<` or `cat file |`, and so is a file `git add -f` forces past `.gitignore`; one the hook cannot read blocks the call, and so does one it cannot pin down, such as a message file filled by `cat .env >`. A forced add of a directory scans the ignored files in it. So does a tool call the hook cannot parse.

For a hook of your own, `checkToolCall` holds the same policy:

```js
import { checkToolCall } from 'shell-secrets'

const findings = checkToolCall(
  { kind: 'shell', command },
  { isIgnored: path => isGitIgnored(path), readFile: path => readOrNull(path) },
)
```

### Pre-commit check on the staged diff

Scans only the lines being added, so secrets already in the history don't block every commit.

```js
// scripts/check-staged.mjs, run from a pre-commit hook (husky, lefthook, …)
import { execFileSync } from 'node:child_process'
import { findSecrets } from 'shell-secrets'

const diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], { encoding: 'utf8' })
const added = diff
  .split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1))
  .join('\n')

const findings = findSecrets(added)
for (const f of findings)
  console.error(`${f.name}: ${f.preview}`)
process.exit(findings.length > 0 ? 1 : 0)
```

### Scrub logs

Replace each secret with its preview before the line leaves the process.

```ts
import { findSecrets } from 'shell-secrets'

export function scrub(line: string): string {
  let out = line
  let limit = line.length
  for (const f of findSecrets(line).reverse()) {
    if (f.end <= limit) {
      out = out.slice(0, f.start) + f.preview + out.slice(f.end)
      limit = f.start
    }
  }
  return out
}
```

## Compared with other scanners

| | shell-secrets | [@sanity-labs/secret-scan](https://www.npmjs.com/package/@sanity-labs/secret-scan) | [@redact-secret/core](https://www.npmjs.com/package/@redact-secret/core) | [secretlint](https://github.com/secretlint/secretlint) | [gitleaks](https://github.com/gitleaks/gitleaks) |
| --- | --- | --- | --- | --- | --- |
| Runtime | Node.js library | JS library, Node and browser | Rust core via wasm, Node and browser | Node.js CLI and library | Go binary |
| Input | one string or command, in-process | one string, in-process | one string, in-process | files; `@secretlint/core` API takes content | files, git history, stdin |
| Rules | 38 curated, plus a generic rule | 1,100+, from TruffleHog detectors | built-in detectors plus declarative rulesets | presets for many providers | large built-in set, with entropy thresholds |
| Redaction | masked preview in each finding | `redact()` | `scanAndRedact()` | no | no |
| Runtime dependencies | 0 | 0 | 1 (its wasm build) | several | — |
| Shell-command analysis | yes | no | no | no | no |

The string scanners above cover far more providers than shell-secrets: @sanity-labs/secret-scan ships over 1,100 rules against its 38. Use one of them, or gitleaks or secretlint for a repository and its history, when coverage is what you need. Use shell-secrets when the input is a shell command or an agent's tool call and you need to know what the command does with the secret — exports it, writes it to a file, or puts it in a commit message — and where a false positive costs a blocked action.

## Limits

- A secret with no recognisable shape is found only under a secret-sounding name, and only when it looks random: a human-chosen `password = "summer2024"` is not reported.
- 38 rules, not hundreds. Add your own for the services you use.
- No git history scanning; the CLI only installs and runs the agent hook.
- macOS and Linux only: the hook command runs through a POSIX shell.
- Shell parsing is best effort. A command it cannot read is not treated as a plain write, which is the stricter answer.
- Plain `git add` and `git commit -a` are not scanned: they stage files git already tracks or does not ignore, which a write to them was checked against when it was made. Scan the staged diff with the [pre-commit recipe](#pre-commit-check-on-the-staged-diff) to cover them.
- A script run from a file or a pipe (`bash deploy.sh`, `curl … | bash`, `python publish.py`) runs code the command line does not show, and a variable set outside the command (`-m "$TOKEN"` with `TOKEN` from the agent's environment) expands to a value the hook never sees; neither is followed.

## Contributing

Issues and pull requests are welcome at [github.com/devmaxxx/shell-secrets](https://github.com/devmaxxx/shell-secrets).

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Test fixtures are assembled at runtime in [`test/support/fake.ts`](./test/support/fake.ts) so the repository holds nothing secret-shaped. Keep it that way: build new fakes there instead of pasting tokens into tests.

## License

[MIT](./LICENSE) © devmaxxx
