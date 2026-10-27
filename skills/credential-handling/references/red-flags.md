# Red flags

| Thought | Reality |
|---|---|
| "A placeholder is harmless, the user fills it in" | Whatever they fill in goes to shell history and, through `!`, into the transcript. And the session usually could have found it. |
| "I'll show `export TOKEN=<your-token>` once, then reference `$TOKEN`" | Same slot, one step earlier. Use a no-echo store (`security add-generic-password … -w`) or the tool's login. |
| "The user can just paste it in chat" | The transcript is replayed every turn and kept with the session. The secrets hook blocks it for a reason. |
| "`echo $TOKEN \| head -c 4` to check it is set" | Partial values still leak. `[ -n "$TOKEN" ] && echo set`. |
| "`cat .env` to see which variables exist" | `grep -oE '^(export )?[A-Za-z_][A-Za-z0-9_]*=' .env` lists the names without the values. |
| "`curl -v` to debug the 401" | Verbose prints the `Authorization` header. Read the status and body instead. |
| "No token on this machine, I'll try the other account's" | Wrong identity is worse than no identity. Stop and name the credential. |
| "It's only a test key" | Test keys get reused, and the habit does not check which key it is holding. |
| "The docs show `--api-key <KEY>`, so that's the command" | Docs write for humans at a prompt. Pass the flag a reference: `--api-key "$(op read …)"`, or use the tool's env-var form. |
