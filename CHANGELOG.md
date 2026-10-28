# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `findCredentialSlots(text)` and `findCredentialSlotsInCommand(cmd)`: the places a text or command leaves for the user to type a secret into (`Authorization: Bearer <YOUR_TOKEN>`, `export API_KEY=your-key`, `--client-secret=<secret>`, `postgres://app:<password>@db`), with offsets, the variable, flag or header they fill, and a preview. References the shell expands, redirections, regex classes, names that hold a path, an id, a URL or a count (`--token-file`, `--secret-id`, `--max-tokens`), and stand-ins for a path, a number or a removed value (`<path>`, `<N>`, `<redacted>`) are not slots.
- The hook blocks a Bash command that carries a credential slot outside heredoc bodies (including one inside `"$(cat <<'EOF' … )"`), comments and the arguments of a text search or edit (`grep`, `rg`, `sed`, `awk`, `jq`, `perl`), and tells the agent to pass the credential by reference or hand the user a no-echo login.
- A `Stop` hook for Claude Code and Codex: a reply whose fenced code blocks or `` `! …` `` spans hand the user a credential slot is sent back once to be rewritten. `install` writes the entry and `uninstall` removes it. Unlike the `PreToolUse` entry it fails open, so a hook that cannot start never keeps the agent from stopping. An install whose skill step fails writes no hooks either.
- The `credential-handling` skill ships in the package, and `install` copies it to `~/.claude/skills/` (Claude Code) or `~/.agents/skills/` (Codex), or the project's with `--project`. A directory of the same name that `install` did not write is left alone.

### Changed

- The hook, `install` and `uninstall` run on [agent-base-kit](https://github.com/devmaxxx/agent-base-kit), bundled into the build, so the package still has no runtime dependencies. `install` and `uninstall` still find every form an earlier version wrote, including its `Stop` entry.
- The installed commands pass `--event` and `--agent` to the hook, so a `Stop` payload that arrives cut short lets the agent stop instead of blocking. The command changes once on upgrade, so Codex asks for trust again. A command without the flags still works.
- The hook blocks a payload that names no tool, is not a JSON object, or carries a `cwd` that is not a string, instead of letting it run or falling back to its own working directory.
- A `MultiEdit` call is checked edit by edit, so a secret one edit moves out of another edit's old text still blocks.
- `install` runs the copied build once before it writes the config, and refuses if the copy does not start.
- `install` and `uninstall` refuse an unknown flag or an extra argument, instead of ignoring it, so a mistyped `--project` no longer falls back to the global config.
- The config file is replaced in one rename, keeps its mode and stays a link when it is one, and an `uninstall` that finds no hook leaves it untouched.
- `install` and `uninstall` print the skill step on a line of its own after the config file.

### Fixed

- The hook no longer blocks a `git tag` (or any publish) whose options an echo behind a test prints, such as `git tag $( [ "$(git cat-file -t v1)" = tag ] && echo "-a -m v2" ) v2`, or a message file `tee` writes from its own literal heredoc (`tee body.md <<'EOF'`). A literal echo's output is now read as words of the command, so `git tag $(echo -F msg.txt) v1` scans `msg.txt`, which it used to let through unread.
- The hook no longer blocks a message file that does not exist yet and that the command does not write, a file the command fills from a `gh pr view`, `gh issue view` or `gh api` redirect, or a path built from a variable the command never sets. A variable the command sets to a plain word is resolved, and one filled any other way still blocks. `GuardEnv` gains an optional `isMissing`.
- A global `install` no longer points the hook at the installing package, whose path an nvm or Homebrew Node upgrade, an `npx` cache clean or a rebuild removes or changes; it copies the build to `~/.shell-secrets/<build>/` and runs it through the `~/.shell-secrets/current` link on the Node.js that ran `install`, falling back to the `node` on PATH. The command no longer changes between versions installed by the same Node.js, so Codex keeps trusting it, and the Claude Code `PreToolUse` entry sets `onFailure: "block"` so a hook that cannot start or times out blocks the call.
- On a Node.js older than 22 the hook blocks with a message naming the Node it found, and `install` refuses, instead of running an untested check; the `Stop` hook exits 0 there, so the reply stands.

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

[Unreleased]: https://github.com/devmaxxx/shell-secrets/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/devmaxxx/shell-secrets/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devmaxxx/shell-secrets/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devmaxxx/shell-secrets/releases/tag/v0.1.0
