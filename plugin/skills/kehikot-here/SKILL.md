---
name: kehikot-here
description: Assign this Claude Code conversation to the kehikko on screen in Kehikot. Only a person runs it, by typing /kehikot-here (add "own" to make it that kehikko's own conversation).
argument-hint: "[own] [kehikko: <key>]"
disable-model-invocation: true
allowed-tools: Bash(curl:*), Bash(echo:*)
---

The person typed `/kehikot-here $ARGUMENTS` to assign THIS conversation to the kehikko they have on screen in Kehikot. Kehikot's Claude module at {{origin}} was asked, with this conversation's id. Its answer, then curl's own report in brackets:

!`curl -s -m 5 --retry 4 --retry-connrefused --retry-delay 1 --retry-max-time 12 -w '\n[curl exit %{exitcode}: %{errormsg}; HTTP %{http_code}]\n' -X POST -G --data-urlencode "session=${CLAUDE_SESSION_ID}" --data-urlencode "say=$ARGUMENTS" {{origin}}/api/here || echo "[no answer from {{origin}}]"`

What to do:

1. If the answer above begins with "Kehikot:" and the report says HTTP 200, tell the person that answer, word for word, without the bracketed report, and stop. Do nothing else: the module has done what was asked, or said why not and what to type instead.
2. Otherwise the module is restarting, is not running, is older than this skill, or moved to another port after this skill was installed. Run this one command with the Bash tool, once, exactly as written: it asks the address the module registered. If what it prints begins with "Kehikot:" and its report says HTTP 200, tell the person that answer, word for word, without the bracketed report, and stop.

   ```sh
   curl -s -m 5 --retry 4 --retry-connrefused --retry-delay 1 --retry-max-time 12 -w '\n[curl exit %{exitcode}: %{errormsg}; HTTP %{http_code}; %{url_effective}]\n' -X POST -G --data-urlencode "session=${CLAUDE_SESSION_ID}" --data-urlencode "say=$ARGUMENTS" "$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(http:\/\/127\.0\.0\.1:[0-9]*\)".*/\1/p' "$HOME/Library/Application Support/Kehikot/modules/kehikot.claude.json")/api/here"
   ```

3. If that did not give an answer (it failed, printed nothing useful, or the person did not allow it), tell the person ONE line, built from the first report above, and stop:
   - curl exit 7 (could not connect), 28 (timed out), 52 or 56 (connection closed), or no answer at all: "Kehikot: couldn't reach the Claude module at {{origin}} (REASON; it may be restarting or not running). Try /kehikot-here again in a moment; if it keeps failing, update Claude from Kehikot's Updates menu. [skill {{version}}]" — REASON is "connection refused" for 7, "timed out" for 28, "connection closed" for 52 or 56, "no answer" otherwise.
   - curl exit 0 with HTTP 404, 403 or 405: "Kehikot: the Claude module at {{origin}} answered HTTP CODE to /kehikot-here, so it is older than this skill (or another program has its port). Update Claude from Kehikot's Updates menu, then type /kehikot-here again. [skill {{version}}]"
   - anything else: "Kehikot: the Claude module at {{origin}} did not assign this conversation (curl exit N, HTTP CODE: ERROR). Try /kehikot-here again in a moment; if it keeps failing, update Claude from Kehikot's Updates menu. [skill {{version}}]" — with curl's numbers and error message from the report.

Never run either command again on your own, with another session id, or with other words: only the person assigns a conversation, by typing the command.
