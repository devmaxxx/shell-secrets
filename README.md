<div align="center">

<img src="docs/assets/logo.svg" width="96" height="96" alt="">

# shell-secrets

**Catch a secret in a shell command or an AI-agent tool call before it runs — written to a file, exported, or put in a commit message. Zero dependencies.**

[![npm version](https://img.shields.io/npm/v/shell-secrets?color=cb3837)](https://www.npmjs.com/package/shell-secrets)
[![npm downloads](https://img.shields.io/npm/dm/shell-secrets)](https://www.npmjs.com/package/shell-secrets)
[![CI](https://github.com/devmaxxx/shell-secrets/actions/workflows/ci.yml/badge.svg)](https://github.com/devmaxxx/shell-secrets/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/shell-secrets)](https://www.npmjs.com/package/shell-secrets)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![bundle size](https://img.shields.io/bundlejs/size/shell-secrets)](https://bundlejs.com/?q=shell-secrets)
[![license: MIT](https://img.shields.io/npm/l/shell-secrets)](./LICENSE)

[Install](#install) · [Agent hooks](#agent-hooks) · [Quick start](#quick-start) · [Detected secrets](#detected-secrets) · [API](#api) · [Recipes](#recipes) · [Compared](#compared-with-other-scanners)

</div>

<p align="center">
  <img src="./demo/demo.gif" alt="The shell-secrets hook blocks a Bash call that writes a GitHub token into config.js and lets the same write through $GITHUB_TOKEN pass" width="800">
</p>

<details>
<summary><b>Table of contents</b></summary>

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Agent hooks](#agent-hooks)
- [Quick start](#quick-start)
- [Detected secrets](#detected-secrets)
- [API](#api)
  - [`findSecrets`](#findsecretstext-options)
  - [`findNewSecrets`](#findnewsecretsbefore-after-options)
  - [`findSecretsInCommand`](#findsecretsincommandcmd-options)
  - [`onlyWritesTo`](#onlywritestocmd-accept)
  - [`findCredentialSlots`](#findcredentialslotstext)
  - [Custom and disabled rules](#custom-and-disabled-rules)
- [Recipes](#recipes)
- [Compared with other scanners](#compared-with-other-scanners)
- [Limits](#limits)
- [Contributing](#contributing)
- [License](#license)

</details>

## Why

Coding agents and CI bots run shell commands, and that is where secrets leak now: `echo "$KEY" > config.js`, `export GITHUB_TOKEN=ghp_…` landing in a transcript, a token pasted into the message file of `git commit -F msg.txt`. Repository scanners like gitleaks and secretlint catch it after the fact, in files and history. Generic string scanners see the token but not what the command does with it.

`findSecretsInCommand` reads the command the way the shell would: it reports each secret, the variable it is exported or assigned to, the files the command writes through `>`, `>>` or `tee`, the message files `git` / `gh` would publish, and the files `curl`, `scp` or `nc` would send off the machine. It is a plain JavaScript function with no dependencies, so it fits in a pre-tool-use hook. It returns where the secret is and a masked preview, never the secret itself. `findSecrets` does the same for any plain string — a log line, a prompt, a staged diff.

## Features

- **Reads shell commands.** `findSecretsInCommand` reports secrets assigned or exported (`NAME=secret`), the files a command writes through `>`, `>>` or `tee`, the message files `git` / `gh` would publish, and the files `curl`, `scp` or `nc` would send off the machine.
- **Built for agent tool calls.** `onlyWritesTo` answers "does this command only write the secret into an allowed file, such as a gitignored `.env`?".
- **Catches credential slots.** `findCredentialSlots` finds the other half of the problem: a command with a stand-in for the user to type a secret into (`Authorization: Bearer <YOUR_TOKEN>`, `export API_KEY=your-key`, `--client-secret=<secret>`, `postgres://app:<password>@db`). The hook blocks one in a Bash call and sends back a reply that hands one to the user.
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

## Agent hooks

The `shell-secrets` command installs a `PreToolUse` hook for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/hooks) (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) or [Codex](https://developers.openai.com/codex/hooks) (`Bash`, `apply_patch`). It blocks a call that carries a new secret with exit code 2, which shows the masked finding to the agent. It also blocks a Bash command with a [credential slot](#credential-slots), and installs a `Stop` hook that sends back a reply handing the user one, along with the [credential-handling skill](#the-credential-handling-skill) that tells the agent what to write instead.

For Claude Code the hook is this entry in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node '/path/to/shell-secrets/dist/cli.mjs' hook || exit 2",
            "timeout": 10,
            "statusMessage": "Scanning for secrets"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node '/path/to/shell-secrets/dist/cli.mjs' hook",
            "timeout": 10,
            "statusMessage": "Checking the reply for credential slots"
          }
        ]
      }
    ]
  }
}
```

The command tells the events apart by `hook_event_name`. Only the `PreToolUse` entry turns a hook that cannot start into exit 2: at `Stop` that would send every reply back, the retry included, and the agent could never stop.

One command writes it for you:

```sh
npx shell-secrets install claude
```

It writes to `~/.claude/settings.json` and copies the skill to `~/.claude/skills/credential-handling/`. The other forms:

```sh
npx shell-secrets install codex    # ~/.codex/hooks.json and ~/.agents/skills/; then trust it once in /hooks
npx shell-secrets install claude --project   # .claude/settings.json and .claude/skills/, runs the repo's devDependency
npx shell-secrets uninstall claude
```

Installing again replaces the earlier entries and skill copy, and leaves other hooks alone. A project install runs `npx --no-install shell-secrets hook`, so add the package as a devDependency there; without it the hook blocks every tool call rather than letting them run unchecked.

### Examples

What the hook does with tool calls an agent might make, in a repository whose `.gitignore` lists `.env` (`ghp_…` stands for a real token):

| Tool call | Result |
| --- | --- |
| Bash `echo "GITHUB_TOKEN=ghp_…" >> config.js` | Blocked: the token lands in a tracked file |
| Bash `export GITHUB_TOKEN=ghp_…` | Blocked: the token lands in the transcript |
| Write `src/config.ts` with `export const token = "ghp_…"` | Blocked |
| Bash `git commit -F msg.txt`, where `msg.txt` holds a token | Blocked: the message would be published |
| Bash `curl --data-binary @.env https://…` | Blocked: the ignored file is uploaded off the machine |
| Bash `echo "git add -f .env" \| cat \| bash` | Blocked: the piped script forces the ignored file |
| Bash `echo "GITHUB_TOKEN=$GITHUB_TOKEN" >> config.js` | Passes: a variable reference, not a secret |
| Bash `echo "GITHUB_TOKEN=ghp_…" >> .env` | Passes: `.env` is ignored and untracked |
| Bash `echo "GITHUB_TOKEN=ghp_…" >> .env; cp .env config.js` | Blocked: the copy leaks it |

A blocked call returns this to the agent, which then usually rewrites the call through the variable:

```text
Blocked by shell-secrets, the call contains a secret:
GitHub token (ghp_********): use $GITHUB_TOKEN
Reference it through an environment variable, or write it only to a gitignored file such as .env.
```

To try the hook without an agent, pipe it a tool call in the agent's JSON shape:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"echo \"TOKEN=$TOKEN\" >> config.js"}}' \
  | npx shell-secrets hook; echo "exit $?"   # exit 0; a literal token gives exit 2
```

### Credential slots

An agent that cannot find a credential tends to hand the user a command with a slot to type it into. Whatever the user types lands in shell history and, run through Claude Code's `!`, in the transcript; and the agent usually could have found it on the machine. The hook treats the slot itself as the leak:

| Where | Example | Result |
| --- | --- | --- |
| Bash call | `curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.github.com/user` | Blocked with exit 2: it would send the stand-in itself |
| Bash call | `curl -H "Authorization: Bearer $(gh auth token)" https://api.github.com/user` | Passes: a reference the shell expands |
| Bash call | `gh pr create --body-file - <<'EOF'` whose body quotes `export API_KEY=<your-key>` | Passes: a heredoc body or a comment is never run |
| Reply | a fenced block with `export OPENAI_API_KEY=your-api-key` | Sent back with `{"decision":"block","reason":"…"}` to rewrite |
| Reply | an inline `` `! psql postgres://app:<password>@db/app` `` | Sent back |
| Reply | prose such as `` no more `export KEY=<your-key>` `` | Passes: an inline span without `!` talks about the pattern |

Both messages tell the agent to pass the credential by reference (`$NAME`, `$(gh auth token)`, one key read from a gitignored `.env` in the same call, `$(security find-generic-password -s <service> -w)`) or to hand the user a no-echo login (`! gh auth login`, `! security add-generic-password -U -a "$USER" -s <service> -w`). A reply is sent back once: when `stop_hook_active` says the agent is already rewriting for a Stop hook, the next reply stands, so one that has to quote a slot to explain it cannot loop. Codex sends `Stop` with the same fields and reads the same answer, so it gets the entry too.

### The credential-handling skill

`install` copies [`skills/credential-handling`](./skills/credential-handling/SKILL.md) to the agent's skills directory: `~/.claude/skills/` for Claude Code, `~/.agents/skills/` for Codex, or the project's `.claude/skills/` / `.agents/skills/` with `--project`. The hook blocks a live secret and a slot; the skill says what to write instead: where credentials already live on the machine and how to check for one without printing it, how to pass one by reference, which no-echo login to hand the user when nothing holds it, and when to stop and name the missing credential. The copy carries a `.installed-by-shell-secrets` marker; install and uninstall leave a directory of the same name without it alone and say so.

### What passes

A secret is let through when it only lands in a file git ignores and does not track, such as `.env`: `echo "TOKEN=..." >> .env` passes, `... >> .env; cp .env config.js` does not, and neither does a write to an ignored name that is a symbolic or hard link. The files `git commit -F`, `gh --body-file` and `gh variable set` publish are scanned too, including one fed to `-F -` through `<` or `cat file |`, and so is a file `git add -f` forces past `.gitignore`; one the hook cannot read blocks the call (a pipe or a device, a file over 16 MiB, or one past the 64 MiB a call may read in all), and so does one it cannot pin down, such as a message file filled by `cat .env >`. The hook gives its git and file work 6 seconds, inside the 10 the installer allows, and blocks what it has not checked by then. A forced add of a directory scans the ignored files in it. A tool call the hook cannot parse is blocked as well. Shell code the command hands on is read the same way: code run by `bash -c`, `eval`, `su -c`, `env -S`, `watch` or a heredoc, and literal text an `echo`, `printf` or `cat <<EOF` pipes into a shell. A substitution in the body of a heredoc with an unquoted delimiter runs, so it is read too (`cat <<EOF` over `$(git add -f .env)`), while a quoted one (`<<'EOF'`) makes the body plain text. A git or gh named through a variable or substitution (`$(which git) add -f .env`) is read as git or gh, and a subcommand filled in that way (`git $(…) -f .env`) blocks the call; so is one spelled by a glob that could be it (`gi[t]`, `g?t add -f .env`). An unquoted brace group is spread into the words the shell makes of it, so `{git,add,-f,.env}`, `git add {-f,.env}` and `git add -f .env{,.bak}` are read as written out, and `{g,}it` as `git it`, which publishes nothing; a word of a git or gh command that spreads past 256 words, or past 4096 extra words in one command, blocks the call. Bash drops an empty alternative and zsh keeps it as an empty word, which moves the value an option takes, so a group that may leave no word (`curl -A {,-d} @.env …`, `git add {-f,$(…)} .env`) is read both ways. Code printed into a shell is followed through stages that only pass stdin along (`… | cat | bash`, `… | tee x | bash`); a stage that rewrites the bytes (`sed`, `tr`, `base64 -d`) hides the script and blocks the call. Files sent off the machine are scanned like a published message: a `curl`, `wget` or HTTPie upload (`--data-binary @.env`, `-F field=@.env`, `-T .env`), an `scp` or `rsync` to a remote host, and a file `nc` reads through `<` or a pipe; an unreadable one blocks, and so does a glob or a variable it cannot expand (`scp dist/* host:/x`, `curl -T "$F" …`). A request body the shell fills in (`curl -d "$(cat .env)"`, `wget --post-data="$k"`, an HTTPie `key="$(…)"` item) blocks the call like a message it fills in, while a header (`-H "Authorization: Bearer $(gh auth token)"`), a URL or a single-quoted body does not. `sftp`, a curl config file (`-K`) and a shell or an uploader named through a glob or a variable (`ba[s]h -c`, `$sh -c`, `cur[l]`, `$c`) are not read. `git stash` carries its message like `git commit`. `gh secret set NAME < .env` passes: a secret is where that value belongs.

### A hook of your own

`checkToolCall` holds the same policy:

```js
import { checkToolCall } from 'shell-secrets'

const findings = checkToolCall(
  { kind: 'shell', command },
  { isIgnored: path => isGitIgnored(path), readFile: path => readOrNull(path) },
)
```

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
| `mysql-password` | Password glued to `-p` on a `mysql`, `mysqldump` or `mariadb` command line | `mysql -u user -p<password>` | — |
| `generic-secret` | Random-looking value under a secret-sounding name | `API_TOKEN=••••`, `--api-key ••••`, `<password>••••</password>` | — |

The last five are fallbacks: where one overlaps a provider rule's finding, only the provider's is reported. `generic-secret` judges the value with the randomness test from [ripsecrets](https://github.com/sirwart/ripsecrets) (distinct characters, character-class balance and common bigrams) and drops runs of the alphabet, UUIDs, member paths such as `process.env.TOKEN`, file paths and names that hold a hash or public key.

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
  messageFiles: string[] // files git, gh or a network tool publish verbatim (commit -F, --body-file, a stdin source, add -f, gh uploads and variables, a curl/scp/nc send, a stash message)
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

The scanner cannot read `messageFiles`; pass their contents to `findSecrets` yourself. A file that does not exist yet and that the command does not write is no leak, so give `GuardEnv` an `isMissing` to tell it from one that cannot be read; the hook does. A path built from a variable is read from the command's own plain assignment (`S=/tmp/x; gh pr create --body-file "$S/body.md"`), and one whose variable the command never sets, because the shell inherits it, is let through. A file the command fills from a `gh pr view`, `gh issue view` or `gh api` redirect is read like any other, since the reply holds no local file. A file the command first writes from literal text (`echo`, `printf`, a heredoc that does not expand, a `tee` or bare `cat` fed by one) is left out, since that text is already in the command; one that any other command names first, such as `cp .env msg`, is unresolved, since what is on disk now is not what gets published. `git add -f -A` lists `.`, and a forced add can name a directory: give `checkToolCall` a `listIgnored` in its `GuardEnv` to scan the ignored files under it, which the hook does through `git ls-files` up to 2000 files. `gh gist create`, `gh release create` / `upload` assets, `gh api --input`, `gh api` and `gh workflow run -F key=@file`, and the env file or stdin `gh variable set` stores are read as published files too. The command is found by name however it is quoted or wrapped (`'git'`, `\git`, `nice`, `timeout`); a name the shell fills in (`$g`, `$(which git)`) or spells with a glob (`gi[t]`, `g?t`) is read as git or gh, whichever its arguments would make publish. A brace group, a sequence among them (`file{1..3}`, `{a..c}`, `{01..10..3}`), is spread into separate words wherever a word stands in a command line, so it can spell the command, the subcommand, an option or a path (`{git,add} -f .env`); `${…}`, a quoted group and a substitution's inside are left as they are. A group that may leave no word (`{,-d}`, `{-f,$(…)}`) is read as bash reads it and as zsh does, since they differ on an empty alternative. Shell code run through `bash -c`, `eval`, a heredoc, `su -c`, `script -c`, `flock -c`, `env -S` or `watch`, or piped into a shell by a literal `echo`, `printf` or `cat <<EOF`, is read the same way, and the pass-through stages between that printer and the shell (`cat`, `tee`) are stepped through while a stage that transforms the bytes leaves the script unresolved. Files a command uploads or copies off the machine are published too: `curl` / `wget` / HTTPie bodies and forms (`--data-binary @file`, `-F k=@file`, `-T file`, `--post-file`), an `scp` or `rsync` whose last operand is a remote host, and a file `nc` reads from `<` or a pipe; `git stash` publishes its message like `git commit`. `unresolvedSources` holds what it cannot pin to a file: `git add --pathspec-from-file`, a `--body-file -` fed by a stage other than `cat`, `head` or `tail`, a relative path after `cd`, `su -` or under `git -C`, a file the command fills any other way, arguments built by `xargs`, a git or gh subcommand the shell fills in (`git $(echo add)`), text built by a command or process substitution (`-m "$(cat .env)"`, `-F <(…)`, a substitution passed to a function defined on the line) other than a literal `$(cat <<'EOF' … EOF)` or `$(echo …)`, a `curl`, `wget` or HTTPie request body filled in the same way (`curl -d "$(cat .env)"`), a word of a git or gh command whose brace groups spread past 256 words (`git add {1..300}`), and a command over 100,000 characters.

### `onlyWritesTo(cmd, accept)`

`true` when the command's whole effect is writing to files and `accept(path)` approves every target — for example, "a secret may go into a gitignored `.env`, nowhere else".

```ts
onlyWritesTo(`echo "GITHUB_TOKEN=${token}" >> .env`, path => path === '.env') // true
```

Only a lone `echo`, `printf` or `cat` with `>`, `>>` or `| tee` qualifies. A chained, substituted or otherwise piped command never does, nor does a target containing `~`, `$`, a glob or a backtick; `accept` is not called for those.

### `findCredentialSlots(text)`

Every place `text` leaves for the user to type a secret into, as a `CredentialSlot[]` ordered by position: a secret-named variable, key or flag (`OPENAI_API_KEY=`, `api_key:`, `--client-secret`, `--token <…>`) or an `Authorization` header set to a stand-in (`<token>`, `your-key`, `paste-here`, `xxxx`, `TOKEN_HERE`, `[password]`, `changeme`), and the password of a URL (`postgres://app:<password>@db`). A reference the shell expands (`$TOKEN`, `${TOKEN:-}`, `$(gh auth token)`), an empty value, a stand-in under a name that is no secret (`<project-id>`) or whose last word says it holds a path, an id, a URL or a number (`--token-file`, `--secret-id`, `TOKEN_URL`, `--max-tokens`, `--tokenizer`), a stand-in for a path or a number (`<path/to/key.json>`, `<N>`, `<url>`) or for a value already gone (`<redacted>`, `<empty>`), a type (`Promise<Token>`), a redirection (`< in > out`) and a regex class (`[a-z0-9]`) are not slots. A real-looking value is not one either; that is `findSecrets`' to report.

```ts
interface CredentialSlot {
  start: number // text.slice(start, end) is the stand-in, e.g. '<YOUR_TOKEN>'
  end: number
  name: string | null // 'OPENAI_API_KEY', '--client-secret', 'Authorization'; null for a URL password
  preview: string // 'Authorization: Bearer <YOUR_TOKEN>': no secret, so shown as written, up to 80 characters
}
```

```ts
findCredentialSlots('vercel deploy --token <token>')
// [{ start: 22, end: 29, name: '--token', preview: '--token <token>' }]
```

### `findCredentialSlotsInCommand(cmd)`

`findCredentialSlots` over a shell command, skipping comments, heredoc bodies (one inside `"$(cat <<'EOF' … EOF)"` too) and the arguments of a command that searches or edits text (`grep`, `rg`, `git grep`, `sed`, `awk`, `jq`, `yq`, `perl`): a PR body or commit message may quote the slot it is about, a pattern may look for one, and none of them runs. Offsets refer to `cmd`.

### `checkToolCall(call, env, options?)`

The secrets an agent's tool call would leak. `call` is `{ kind: 'shell', command }`, `{ kind: 'write', path, content }`, `{ kind: 'edit', path, before, after }` or `{ kind: 'patch', patch }` (Codex `apply_patch`). `env.isIgnored(path)` says whether a file may hold a secret; `env.readFile(path)` returns a file's text or `null`. Writes into ignored files and secrets an edit only keeps return nothing.

### `defaultRules`

The frozen, ordered list of built-in `Rule`s from the table above.

### Types

`Finding`, `CommandFinding`, `CommandScan`, `CredentialSlot`, `Rule` and `ScanOptions` (`{ rules?: readonly Rule[] }`) are exported as types.

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

The string scanners above cover far more providers than shell-secrets: @sanity-labs/secret-scan ships over 1,100 rules against its 39. Use one of them, or gitleaks or secretlint for a repository and its history, when coverage is what you need. Use shell-secrets when the input is a shell command or an agent's tool call and you need to know what the command does with the secret — exports it, writes it to a file, or puts it in a commit message — and where a false positive costs a blocked action.

## Limits

- A secret with no recognisable shape is found only under a secret-sounding name, and only when it looks random: a human-chosen `password = "summer2024"` is not reported. Names are matched without regard to case, and `pass` counts unless a letter follows it: `DB_PASS`, `smtp.pass` and `dbPass` are secret names, `passport` is not.
- 39 rules, not hundreds. Add your own for the services you use.
- A provider token with a letter, digit, `_` or `-` right before its prefix (`x-ghp_…`) is not reported by its provider's rule, which keeps a prefix inside a longer identifier from matching. Under a secret-sounding name the generic rule may still report it.
- `findNewSecrets` drops a finding only when its exact text is in `before`, so a secret that `before` held base64-encoded and `after` holds decoded is reported as new: the edit writes it where anyone can read it.
- No git history scanning; the CLI only installs and runs the agent hook.
- macOS and Linux only: the hook command runs through a POSIX shell.
- Shell parsing is best effort. A command it cannot read is not treated as a plain write, which is the stricter answer.
- The `.env` exemption is narrow on purpose. Only a lone `echo`, `printf` or `cat` writing through `>`, `>>` or `tee` qualifies, so a write to an ignored file is still blocked when it is chained (`cd app && echo … >> .env`), built with a substitution, piped through anything but `tee`, or aimed at a path holding `~`, `$` or a glob.
- A descriptor duplicated with `>&3` is not followed to its file. `echo … > .env >&3` is read as a write to `.env`, though bash sends the output to whatever an earlier `exec 3>file` opened.
- Plain `git add` and `git commit -a` are not scanned: they stage files git already tracks or does not ignore, which a write to them was checked against when it was made. Scan the staged diff with the [pre-commit recipe](#pre-commit-check-on-the-staged-diff) to cover them.
- Code the command line does not show is not followed: a script run from a file or piped from one or from a download (`bash deploy.sh`, `bash < deploy.sh`, `curl … | bash`), code in another language (`python publish.py`, `node -e "…"`), and a function, shell alias, git alias or variable defined outside the command, in an earlier call, a startup file, git config or the agent's environment (`-m "$TOKEN"`). A command kept in a variable and run by expanding it (`c='git add -f .env'; $c`) is not followed either, nor is an alias defined on the line, which zsh, or bash with `expand_aliases`, would expand.
- `rsync` filters (`--exclude`, `--include`, `--filter`) and `--dry-run` are not applied. Every source operand is scanned, so a file the filter would skip, or a run that sends nothing, can still block the call.
- Syntax only zsh has is read where bash gives it a meaning: `=git` is git, but a glob qualifier (`scp .env(.) host:`, `git add -f *(.)`) ends the command at its parenthesis, so the words after it are not read as its arguments.
- Literal text between two substitutions of one double-quoted string is read as code, so a `#` or an apostrophe there hides what follows: `echo "$(date) # $(git add -f .env)"` runs the add unread.
- A publisher inside a double-quoted substitution (`url="$(gh pr create --body-file body.md)"`) is followed, unless the substitution holds more than seven quoted words of its own.
- Of gh, only the calls that publish text or files are read: `pr`, `issue`, `release`, `gist`, `api`, `variable set`, `workflow run`, `label` and `repo` create and edit, and `project` create, edit, item-create and item-edit. An extension or `gh codespace cp` is not. `gh secret set` is left alone on purpose, since a secret store is where a secret belongs.

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
