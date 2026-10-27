# Where credentials live

Check in this order; stop at the first hit. Every check tests presence — none prints the value.

| Source | Presence check | Reference in a command |
|---|---|---|
| The tool's own login | `gh auth status`, `aws sts get-caller-identity`, `gcloud auth list`, `az account show`, `npm whoami`, `op whoami`, `vercel whoami` | Let the tool authenticate itself; when a raw header is needed, `$(gh auth token --user <account>)` (bare, it returns whichever account is active, which another session may have switched) or `$(gcloud auth print-access-token)` inside the same command; AWS reads its profile itself (`--profile <name>`) |
| An already-signed-in MCP server | The server's own read tool (e.g. a Bitbucket or Jira `get_*`) | Call the MCP tool instead of `curl`-ing the API |
| Environment | `[ -n "$NAME" ] && echo set` | `"$NAME"` |
| The repo's gitignored env file | `git check-ignore -q .env.local && grep -cE '^(export )?NAME="?[^"[:space:]]' .env.local` (an empty value does not count) | Read the one key, never source the file — see below |
| Tool config files | `test -s ~/.config/<tool>/config.json`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json` (credsStore) | Let the tool read its own file; never `cat` it |
| macOS Keychain | `security find-generic-password -s <service> >/dev/null && echo set` | `$(security find-generic-password -s <service> -w)` |
| 1Password CLI | `op whoami` | `$(op read 'op://<vault>/<item>/<field>')`, or `op run --env-file=.env.tpl -- <cmd>` |

Reading one key from the gitignored env file, in the same Bash call as the command that uses it (shell state does not survive to the next):

```sh
export NAME="$(sed -nE 's/^(export )?NAME=//p' .env.local | tr -d '"')"; <cmd>
```

Never `. ./.env.local` or `set -a; . …`: dotenv is not shell syntax, so a value with a space, `;` or `$(…)` runs as a command and its tail is printed in the error.

A `.env` that is tracked by git is not a credential store: a secret found in one is a finding to report, not a source to use.

## When nothing holds it

- **Interactive login, run by the user**: `! gh auth login`, `! npm login`, `! aws configure sso`. These prompt without echo or open a browser.
- **1Password**: not `! op signin` — without the desktop-app integration it prints a session token meant for `eval`, which `!` puts in the transcript and the next Bash call has already lost. Have the user turn on the integration (1Password → Settings → Developer → Integrate with 1Password CLI); every `op` call then prompts the app itself.
- **One-time store**: `! security add-generic-password -U -a "$USER" -s <service> -w` — `-w` last makes it prompt, `-U` replaces a rotated key instead of failing on "already exists". Afterwards the session reads it with `$(security find-generic-password -s <service> -w)`.
- **Gitignored file the user fills in their editor**: create `.env.local` with the names and empty values, confirm `git check-ignore` covers it, and tell the user which line to fill. The session never reads the value back into the conversation.

`read -rs VAR` does not help: each Bash call is a fresh shell, so the variable is gone before the next command runs.
