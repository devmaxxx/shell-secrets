---
name: credential-handling
description: Use before writing a command, script, config or instruction that needs a token, password, API key or other secret — a `curl` with an auth header, a CLI login, an `export`, a `.env` line, a connection string, a "run this" for the user. Finds the credential already on the machine and passes it by reference, or hands the user a no-echo login, instead of a command with a slot for them to paste a secret into. Trigger on "token", "API key", "password", "credentials", "auth header", "login", "export", ".env", and on any `<YOUR_…>` placeholder about to be written.
---

# Credential handling

## Contract

No command, file or message the session writes has a slot for a secret. Not `<YOUR_TOKEN>`, not `export API_KEY=paste-here`, not `--password …`, not "paste your key below". A secret the user types into a command lands in shell history, in the transcript when run through `!`, and in screenshots; the slot also hands the user a lookup the machine can do itself.

The [shell-secrets](https://github.com/devmaxxx/shell-secrets) hook blocks a live secret and a slot in a command or reply; this skill says what to write instead.

## Rules

1. **Look before asking.** Find where the credential already lives — the tool's own login, an env var, the repo's gitignored `.env`, the Keychain, a password-manager CLI, an MCP server that is already signed in. Lookup order and commands: references/where-credentials-live.md.
2. **Pass it by reference.** The command names the source, the shell expands it: `"Authorization: Bearer $(gh auth token --user <account>)"`, one key read from `.env.local` (never sourced), `$(security find-generic-password -s svc -w)`. The value never appears in the command text or its output.
3. **Test presence, never print.** `[ -n "$TOKEN" ] && echo set`, `gh auth status`. Never `echo $TOKEN`, `cat .env`, a bare `gh auth token`, `printenv`, or `-v`/`--verbose` that dumps headers.
4. **Nothing holds it ⇒ a no-echo login, run by the user.** The tool's own interactive login (`gh auth login`, `npm login`, `aws configure sso`; 1Password via its app integration, never `op signin`), or a one-time store that prompts: `security add-generic-password -U -a "$USER" -s <service> -w` with `-w` last. Suggest it as `! <command>`, then read it by reference (rule 2).
5. **Cannot be had at all ⇒ stop and name it.** Which credential, where it is created (the console page), and the rule-4 command that stores it. No command with a slot, no guessing, no fallback to a different account.
6. **Never ask for a secret in chat** and never write one into a tracked file. A `.env.example` holds names and empty values only.

A placeholder for a non-secret value — a project id, a host — is fine, but look it up first.

## Red flags

Details: references/red-flags.md — read when a rule above is about to be argued around.
