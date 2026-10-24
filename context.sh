#!/bin/sh
#
# What a session this module started runs at its start and at each prompt, to be
# told where it is: its place and the modules on its kehikko (see context.ts).
#
#   /bin/sh context.sh <SessionStart|UserPromptSubmit>
#
# It is a hook of the session's own plugin (`hooks/hooks.json` in the folder
# this module assembles for the session, `sessionPlugin` in skills.ts), copied
# into that folder beside `kehikot/token`, `kehikot/origin` and
# `kehikot/registration`, which this module wrote there 0600 for this one
# session. Claude Code adds what a SessionStart or UserPromptSubmit hook prints
# as JSON (`hookSpecificOutput.additionalContext`) to what the model is given
# (measured on 2.1.309 with a scratch config); that is the whole point of it,
# so unlike tell.sh this one prints — and only the answer of this module's own
# server, only when it is that answer.
#
#   - Of what Claude Code hands it, one thing leaves this script: the session's
#     id, checked for its exact spelling. The prompt is never read out of it,
#     sent, stored or shown.
#   - The token goes to curl on a pipe, never on a command line.
#   - It speaks only to this computer: the origin is checked to be loopback,
#     and no proxy is used.
#   - It never holds the session up for long and never fails it: four seconds
#     at most, every outcome is exit 0, and anything that is not this module's
#     answer is nothing.
#
# A server that is gone, a curl that is missing, a file that is absent: all the
# same, silently nothing. The session then starts as it did before this existed.

event=${1-}
case $event in SessionStart | UserPromptSubmit) ;; *) exit 0 ;; esac

here=$(/usr/bin/dirname "$0")/kehikot
token=$(/bin/cat "$here/token" 2>/dev/null)
origin=$(/bin/cat "$here/origin" 2>/dev/null)
case $token in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
[ ${#token} -le 64 ] || exit 0

curl=/usr/bin/curl
sed=/usr/bin/sed
[ -x "$curl" ] && [ -x "$sed" ] || exit 0

# The hook's input is one line of JSON. Inside its strings a quote is escaped, so a
# quoted key followed by a colon is only ever a real key (the prompt cannot fake one).
input=$(/usr/bin/head -c 262144 2>/dev/null | /usr/bin/tr -d '\n\r')
session=$(printf '%s' "$input" | "$sed" -n 's/.*"session_id" *: *"\([0-9a-f-]\{36\}\)".*/\1/p')
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac

ask() {
  case $1 in http://127.0.0.1:[0-9]*) ;; *) return 1 ;; esac
  printf 'header = "x-module-ticket: %s"\n' "$token" |
    "$curl" -q --config - --silent --fail --max-time 4 --connect-timeout 1 --noproxy '*' \
      --request POST "$1/api/context?event=$event&session=$session" 2>/dev/null
}

said=$(ask "$origin")
asked=$?
# No answer from there (nothing listening, or something else answering): the module may have moved
# to another port since this session started, and its registration says where. An answer with
# nothing in it is an answer.
if [ "$asked" -ne 0 ] && [ -f "$here/registration" ]; then
  reg=$(/bin/cat "$here/registration" 2>/dev/null)
  if [ -f "$reg" ]; then
    url=$("$sed" -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(http:\/\/127\.0\.0\.1:[0-9]*\)".*/\1/p' "$reg" | /usr/bin/head -n 1)
    [ -n "$url" ] && [ "$url" != "$origin" ] && said=$(ask "$url")
  fi
fi

case $said in '{"hookSpecificOutput":'*) printf '%s\n' "$said" ;; esac
exit 0
