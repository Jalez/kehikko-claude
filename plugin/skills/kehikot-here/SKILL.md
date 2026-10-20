---
name: kehikot-here
description: Assign this Claude Code conversation to the kehikko on screen in Kehikot. Only a person runs it, by typing /kehikot-here (add "own" to make it that kehikko's own conversation).
argument-hint: "[own] [kehikko: <key>]"
disable-model-invocation: true
allowed-tools: Bash(curl:*)
---

The person typed `/kehikot-here $ARGUMENTS` to assign THIS conversation to the kehikko they have on screen in Kehikot. Kehikot's Claude module was asked, with this conversation's id, and answered:

!`curl -s -m 5 -X POST -G --data-urlencode "session=${CLAUDE_SESSION_ID}" --data-urlencode "say=$ARGUMENTS" http://127.0.0.1:8010/api/here`

What to do:

1. If the answer above begins with "Kehikot:", tell the person that answer, word for word, and stop. Do nothing else: the module has done what was asked, or said why not and what to type instead.
2. If it is empty or does not begin with "Kehikot:", the module is not on its usual port. Run this one command with the Bash tool, once, exactly as written, and tell the person what it prints, word for word:

   ```sh
   curl -s -m 5 -X POST -G --data-urlencode "session=${CLAUDE_SESSION_ID}" --data-urlencode "say=$ARGUMENTS" "$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(http:\/\/127\.0\.0\.1:[0-9]*\)".*/\1/p' "$HOME/Library/Application Support/Kehikot/modules/kehikot.claude.json")/api/here"
   ```

3. If that prints nothing either, tell the person: "Kehikot's Claude module is not running, so this conversation was not assigned. Start Kehikot and type /kehikot-here again."

Never run either command again on your own, with another session id, or with other words: only the person assigns a conversation, by typing the command.
