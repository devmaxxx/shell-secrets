# secret-sniffer

Find live-looking API tokens, private keys and database passwords in a string or a shell command, before they land in a commit, a log line or a chat transcript.

- Zero runtime dependencies, ESM-only, typed.
- Tuned against false positives: placeholders (`ghp_xxxx…`, `<token>`, `example`), variable references (`${DB_PASSWORD}`, `$(op read …)`) and local dev credentials (`postgres:postgres@localhost`) are not reported.
- A finding carries the rule, the offsets and a redacted preview. It never carries the secret itself.
- Linear time on hostile input, so it is safe to run on every prompt, keystroke or commit.

## Install

```sh
npm install secret-sniffer
# or
pnpm add secret-sniffer
```

Node.js 20 or later.

## What it detects

| Rule id | Detects | Suggested variable |
| --- | --- | --- |
| `github-token` | GitHub classic tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) | `GITHUB_TOKEN` |
| `github-fine-grained-token` | GitHub fine-grained tokens (`github_pat_`) | `GITHUB_TOKEN` |
| `atlassian-api-token` | Atlassian user API tokens and Bitbucket access tokens (`ATATT3`, `ATCTT3`) | `ATLASSIAN_API_TOKEN` |
| `figma-token` | Figma personal access tokens (`figd_`) | `FIGMA_TOKEN` |
| `slack-token` | Slack bot, user, app and refresh tokens (`xoxb-`, `xoxp-`, `xapp-`, …) | `SLACK_TOKEN` |
| `slack-webhook-url` | Slack incoming webhook URLs | `SLACK_WEBHOOK_URL` |
| `anthropic-api-key` | Anthropic API keys (`sk-ant-`) | `ANTHROPIC_API_KEY` |
| `openai-api-key` | OpenAI API keys (`sk-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-`) | `OPENAI_API_KEY` |
| `aws-access-key` | AWS access key IDs, long-lived and temporary (`AKIA`, `ASIA`) | `AWS_ACCESS_KEY_ID` |
| `aws-secret-key` | AWS secret access keys and session tokens, read off their variable name | `AWS_SECRET_ACCESS_KEY` |
| `private-key` | PEM and PGP private keys with a body, including encrypted ones and keys inside JSON strings | — |
| `database-uri-password` | `user:password@host` in MongoDB, PostgreSQL, MySQL, MariaDB, Redis and AMQP URIs | `DATABASE_URL` |
| `database-uri-query-password` | `?password=` in libpq and JDBC URIs | `DATABASE_URL` |
| `telegram-bot-token` | Telegram bot tokens, also inside a Bot API URL | `TELEGRAM_BOT_TOKEN` |
| `jwt` | JSON Web Tokens of 150 characters or more | — |

## Usage

### Scan text

```ts
import { findSecrets } from 'secret-sniffer'

const findings = findSecrets(fileContents)
for (const f of findings) {
  console.warn(`${f.name} at offset ${f.start}: ${f.preview}. Use $${f.env} instead.`)
}
// GitHub token at offset 12: ghp_********. Use $GITHUB_TOKEN instead.
```

Each `Finding` is:

```ts
interface Finding {
  ruleId: string // 'github-token'
  name: string // 'GitHub token'
  env: string | null // 'GITHUB_TOKEN'
  start: number // text.slice(start, end) is the secret
  end: number
  preview: string // 'ghp_********'; values under 20 characters show nothing
}
```

### Scan only what an edit adds

`findNewSecrets(before, after)` reports the secrets in `after` that `before` does not already hold, so an edit that keeps an existing secret as context is not flagged again.

```ts
import { findNewSecrets } from 'secret-sniffer'

findNewSecrets(oldFile, newFile)
```

### Scan a shell command

```ts
import { findSecrets, findSecretsInCommand, onlyWritesTo } from 'secret-sniffer'

const scan = findSecretsInCommand('export GITHUB_TOKEN=ghp_… && git commit -F msg.txt')
scan.findings // [{ ruleId: 'github-token', variable: 'GITHUB_TOKEN', … }]
scan.redirectTargets // files written through >, >> or tee
scan.messageFiles // ['msg.txt']: files git or gh publish verbatim; scan them yourself

// Allow a secret on the command line only when the command does nothing but
// write it into a gitignored .env file.
const harmless = onlyWritesTo(cmd, path => path.endsWith('.env') && isGitIgnored(path))
```

`onlyWritesTo` accepts a lone `echo`, `printf` or `cat` with `>`, `>>` or `| tee`. A chained, substituted or otherwise piped command never qualifies, nor does a target with `~`, `$`, a glob or a backtick in it.

### Add, replace or disable rules

```ts
import type { Rule } from 'secret-sniffer'
import { defaultRules, findSecrets } from 'secret-sniffer'

const acme: Rule = {
  id: 'acme-key',
  name: 'Acme API key',
  env: 'ACME_KEY',
  pattern: /acme_live_([A-Za-z0-9]{24})/,
  secretGroup: 1, // the group that is the secret; defaults to the whole match
}

const rules = [...defaultRules.filter(r => r.id !== 'jwt'), acme]
findSecrets(text, { rules })
```

A rule may also set `ignore(match)` to drop a match, `placeholders: false` to skip the shared placeholder test, and `prepare(text)` to rewrite the text before matching; `prepare` must keep the text's length so offsets stay true.

## Compared with secretlint and gitleaks

[gitleaks](https://github.com/gitleaks/gitleaks) and [secretlint](https://github.com/secretlint/secretlint) scan files and git history with large rule sets. secret-sniffer is a small in-process function for one string or one command at a time — a prompt, a commit message, a tool call, a webhook payload — where a false positive costs a blocked action, so it trades breadth for precision.

## Limits

- Pattern-based: a secret with no recognisable shape (a generic `password = …`, a random hex string) is not found. There is no entropy scan.
- Fifteen curated rules, not hundreds. Add your own for the services you use.
- Shell parsing is best effort. A command it cannot read is not reported as a plain write, which is the stricter answer.
- Offsets are UTF-16 code units, as with `String.prototype.slice`.

## License

[MIT](./LICENSE)
