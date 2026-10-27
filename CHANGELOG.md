# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The hook no longer blocks a message file that does not exist yet and that the command does not write, a file the command fills from a `gh pr view`, `gh issue view` or `gh api` redirect, or a path built from a variable the command never sets. A variable the command sets to a plain word is resolved, and one filled any other way still blocks. `GuardEnv` gains an optional `isMissing`.

## [0.2.1] — 2026-10-19

### Added

- A logo in the README header.

## [0.2.0] — 2026-10-19

### Added

- `findSecretsInCommand` scans the files `curl`, `wget`, HTTPie, `scp`, `rsync` and `nc` send off the machine, and the message `git stash` stores, like a published commit message. An upload the scanner cannot read blocks.
- A `mysql-password` rule for a password glued to `-p` on a `mysql`, `mysqldump` or `mariadb` command line.
- Agent hooks section in the README, after Install, with the Claude Code settings entry and examples of calls the hook blocks and lets through.

### Fixed

- Command lines that hid a publish from the scanner: a carriage return ending a word, ANSI-C quoted strings, braces inside a word, positional parameters, `git --attr-source` / `--shallow-file`, `gh` flags before the subcommand, line continuations, a comment glued to a closing substitution, scripts piped through `cat` or `tee` into a shell, and `git` or `gh` named by a glob or brace (`gi[t]`, `{g,}it`).
- Codex `apply_patch` headers are read the way Codex parses them, so an indented header no longer keeps an ignored file's exemption.
- A base64 blob after `=` is decoded, and a doubly encoded secret previews as the secret.
- The hook blocks a tool input, edit list or edit of the wrong shape instead of reading it as empty.
- `install` writes the hook in when `hooks` or `PreToolUse` is `null`.
- Long hostile command lines scan in linear time, well inside the hook's timeout.
- A PR body that only quotes a bypass inside a quoted heredoc is no longer blocked.

### Changed

- Uploads, pipes into a shell and `git stash` the scanner cannot resolve now block where 0.1.0 let them run. `rsync` filters and dry runs, and request bodies piped from anything but a literal, still block; the README's Limits list them.

## [0.1.0] — 2026-10-17

### Added

- `findSecrets(text, options?)`: every live-looking secret in a string, with offsets and a redacted preview.
- `findNewSecrets(before, after, options?)`: only the secrets an edit or diff adds.
- `findSecretsInCommand(cmd, options?)`: secrets on a shell command line, plus the files it writes and the message files `git` / `gh` publish.
- `onlyWritesTo(cmd, accept)`: whether a command does nothing but write to approved files.
- `defaultRules`: 38 built-in rules for GitHub, GitLab, Atlassian, Figma, Slack, Discord, Linear, Anthropic, OpenAI, Google, Groq, xAI, Hugging Face, AWS, DigitalOcean, Stripe, SendGrid, Shopify, npm, PyPI, Telegram, private keys, age keys, database URIs and JWTs.
- Custom rules through `{ rules }`, with `secretGroup`, `ignore`, `prepare` and `placeholders`.

[0.2.1]: https://github.com/devmaxxx/shell-secrets/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devmaxxx/shell-secrets/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devmaxxx/shell-secrets/releases/tag/v0.1.0
