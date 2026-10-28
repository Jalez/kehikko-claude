#!/bin/sh
#
# What a session's program runs to say what it is doing: one word to this
# module's own server, over loopback, and nothing else.
#
#   /bin/sh tell.sh <event>
#
# It is run by the program in the pty, as one of its hooks (see `reports` in
# program.ts and "Told, not read" in live.ts), and it is written to be the
# least a thing run from inside somebody's agent can be:
#
#   - It says the EVENT'S NAME, which is this script's own argument, and the
#     SESSION, which this module put in the environment when it started the
#     pty. Of what the program supplies on standard input — the prompt, the
#     tool's input, the last answer — nothing is carried, and nothing is read
#     but two things at their moments: on `Stop`, how many background tasks the
#     program says are still running. That is counted here, from the
#     `background_tasks` list of the payload (the tasks that are running or
#     pending: no other kind is listed), and only the NUMBER, up to 99, leaves
#     this script. On `SubagentStart` and `SubagentStop`, the subagent's id and
#     type, each checked for its spelling. No word of the payload is sent,
#     stored or shown.
#   - Nothing is interpolated into a command. The three values come from this
#     module's own environment, each is checked for its exact spelling before
#     it is used, and the secret never appears on a command line: it goes to
#     curl on a pipe, so `ps` does not show it.
#   - It can only ever speak to this computer. The address is not taken from
#     the environment — only a port number is, and it is digits or nothing —
#     because a project's own settings may set variables for the program it
#     runs in, and a whole address from there would be somewhere to send the
#     secret. No proxy is used, whatever the environment says about one.
#   - It never holds the program up and never says anything to it: two
#     seconds at most, every outcome is exit 0, and nothing is printed —
#     what a hook prints can be read by the program as an instruction.
#
# A server that is gone, a curl that is missing, a variable that is absent:
# all the same, silently nothing. The session then has no state, which is
# what it had before this existed.

event=${1-}
port=${KEHIKOT_TELL_PORT-}
secret=${KEHIKOT_TELL_SECRET-}
session=${KEHIKOT_TELL_SESSION-}

case $event in '' | *[!A-Za-z]*) exit 0 ;; esac
case $port in '' | *[!0-9]*) exit 0 ;; esac
case $secret in '' | *[!0-9a-f]*) exit 0 ;; esac
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
[ ${#port} -le 5 ] && [ ${#secret} -le 128 ] && [ ${#session} -le 64 ] && [ ${#event} -le 40 ] || exit 0

# By its full name, so that nothing a project puts on PATH is run in its place.
curl=/usr/bin/curl
[ -x "$curl" ] || exit 0

# On Stop only: how many background tasks are still running, as a number. The payload is one line of
# JSON; its `background_tasks` array is followed by `session_crons`, and every task in it carries
# exactly one "status" of its own (strings inside it are escaped, so a quoted `"status":"` is only ever
# a real key). Anything unclear is no count, which is what a turn's end meant before this was asked.
background=
if [ "$event" = Stop ] && [ ! -t 0 ]; then
  grep=/usr/bin/grep
  wc=/usr/bin/wc
  if [ -x "$grep" ] && [ -x "$wc" ]; then
    body=$(/usr/bin/head -c 262144 2>/dev/null | /usr/bin/tr -d '\n\r')
    case $body in
      *'"background_tasks":'*)
        rest=${body##*'"background_tasks":'}
        tasks=${rest%%,\"session_crons\"*}
        n=$(printf '%s' "$tasks" | "$grep" -o '"status": *"' | "$wc" -l)
        n=$((n + 0)) 2>/dev/null || n=
        if [ -n "$n" ]; then
          [ "$n" -gt 99 ] && n=99
          background=$n
        fi
        ;;
    esac
  fi
fi
extra=
[ -n "$background" ] && extra="&background=$background"

# On SubagentStart and SubagentStop only: the subagent's id and type, each checked for its exact
# spelling, and nothing else of the payload. The module reads what the subagent was asked to do
# (its description) from the sidecar Claude Code keeps beside its record, never from here. A key
# inside a quoted string is escaped (\"agent_id\"), so only the payload's own key matches.
if { [ "$event" = SubagentStart ] || [ "$event" = SubagentStop ]; } && [ ! -t 0 ]; then
  body=$(/usr/bin/head -c 262144 2>/dev/null | /usr/bin/tr -d '\n\r')
  agent=$(printf '%s' "$body" | /usr/bin/sed -n 's/.*"agent_id": *"\([A-Za-z0-9_-]\{1,64\}\)".*/\1/p')
  kind=$(printf '%s' "$body" | /usr/bin/sed -n 's/.*"agent_type": *"\([A-Za-z0-9:._-]\{1,64\}\)".*/\1/p')
  case $agent in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
  case $kind in *[!A-Za-z0-9:._-]*) kind= ;; esac
  extra="&agent=$agent"
  [ -n "$kind" ] && extra="$extra&type=$kind"
fi

printf 'header = "x-module-ticket: %s"\n' "$secret" |
  "$curl" -q --config - --silent --max-time 2 --connect-timeout 1 --noproxy '*' --output /dev/null \
    --request POST "http://127.0.0.1:$port/api/state?event=$event&session=$session$extra" >/dev/null 2>&1

exit 0
