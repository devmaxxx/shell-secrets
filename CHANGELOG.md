# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added

- `findSecrets(text, options?)`: every live-looking secret in a string, with offsets and a redacted preview.
- `findNewSecrets(before, after, options?)`: only the secrets an edit or diff adds.
- `findSecretsInCommand(cmd, options?)`: secrets on a shell command line, plus the files it writes, the message files `git` / `gh` publish and the files `curl`, `wget`, HTTPie, `scp`, `rsync` or `nc` send off the machine.
- `onlyWritesTo(cmd, accept)`: whether a command does nothing but write to approved files.
- `defaultRules`: 31 built-in rules for GitHub, GitLab, Atlassian, Figma, Slack, Discord, Linear, Anthropic, OpenAI, Google, Groq, xAI, Hugging Face, AWS, DigitalOcean, Stripe, SendGrid, Shopify, npm, PyPI, Telegram, private keys, age keys, database URIs and JWTs.
- Custom rules through `{ rules }`, with `secretGroup`, `ignore`, `prepare` and `placeholders`.

[0.1.0]: https://github.com/devmaxxx/shell-secrets/releases/tag/v0.1.0
