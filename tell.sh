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
#     pty. Nothing the program supplies is carried, read or looked at: a hook
#     is handed the prompt, the tool's input and the last answer on its
#     standard input, and this never reads it.
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

printf 'header = "x-module-ticket: %s"\n' "$secret" |
  "$curl" -q --config - --silent --max-time 2 --connect-timeout 1 --noproxy '*' --output /dev/null \
    --request POST "http://127.0.0.1:$port/api/state?event=$event&session=$session" >/dev/null 2>&1

exit 0
