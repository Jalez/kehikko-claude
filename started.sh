#!/bin/sh
# Claude Code's SessionStart hook, as Kehikot's Claude module installs it when a
# person presses "Report sessions started outside Kehikot" (see hook.ts).
#
# Claude Code hands a SessionStart hook a JSON object on standard input:
# session_id, cwd, source (startup, resume, clear, compact), transcript_path and
# hook_event_name. This passes it, unread, to the Claude module's server on this
# machine — whose address is read from its registration, the one argument — so
# the session is listed in that project at once as "not yet assigned". It never
# blocks a session: no answer within two seconds, no module, no curl — it exits
# 0 and Claude Code goes on.
reg="$1"
[ -f "$reg" ] || exit 0
url=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(http:\/\/127\.0\.0\.1:[0-9]*\)".*/\1/p' "$reg" | head -n 1)
[ -n "$url" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "$url/api/sessions/started" || true
exit 0
