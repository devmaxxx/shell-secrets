# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added

- `findSecrets(text, options?)`: every live-looking secret in a string, with offsets and a redacted preview.
- `findNewSecrets(before, after, options?)`: only the secrets an edit or diff adds.
- `findSecretsInCommand(cmd, options?)`: secrets on a shell command line, plus the files it writes and the message files `git` / `gh` publish.
- `onlyWritesTo(cmd, accept)`: whether a command does nothing but write to approved files.
- `defaultRules`: 15 built-in rules for GitHub, Atlassian, Figma, Slack, Anthropic, OpenAI, AWS, Telegram, private keys, database URIs and JWTs.
- Custom rules through `{ rules }`, with `secretGroup`, `ignore`, `prepare` and `placeholders`.

[0.1.0]: https://github.com/arenuzzz/secret-sniffer/releases/tag/v0.1.0
