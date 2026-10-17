# Regenerate with `pnpm build && vhs demo/demo.tape` from the repository root.
Output demo/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 460
Set Padding 24
Set Theme "GitHub Dark"
Set TypingSpeed 35ms

Hide
Type "cd demo && node calls.mjs && export PS1='$ ' && clear"
Enter
Show

Type "# An agent's Bash call puts a token into a tracked file"
Enter
Type "cat leak.json"
Enter
Sleep 1.5s
Type "node no-secrets.mjs < leak.json; echo exit $?"
Enter
Sleep 3s

Type "# The same write through a variable passes"
Enter
Type "node no-secrets.mjs < safe.json; echo exit $?"
Enter
Sleep 3s

Hide
Type "rm leak.json safe.json"
Enter
