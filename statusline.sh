#!/bin/sh
#
# What a session this module started runs as its status line: the person's own status line,
# unchanged, and then — out of the way — Claude Code's status line JSON to this module, which is
# where the context meter's exact window and live cost come from (see meter.ts), and the
# subscription allowance's `rate_limits` (see usage.ts).
#
#   /bin/sh statusline.sh        (Claude Code runs it; its JSON is on stdin)
#
# It is the `statusLine` of the session's own `--settings` (`statusLine` in program.ts), copied
# into the plugin folder this module assembles for the session, beside `kehikot/token`,
# `kehikot/origin` and `kehikot/registration` (see context.sh). `kehikot/statusline` holds the
# person's own status line command, as their settings say it, when they have one; `kehikot/compose`
# holds the runtime this module runs under, when it is to print its own line instead (with
# "Status line in sessions" on, the default).
#
#   - The person's line first, and byte for byte: their command is given exactly the JSON
#     Claude Code gave this one, in the same environment and folder, run by bash as Claude Code
#     runs a status line command; what it prints goes straight out, and its exit status is this
#     script's. With no command of theirs, this module's own line (`statusline-line.mjs`: context,
#     the weekly and five-hour allowance, the model) when `kehikot/compose` names a runtime that
#     runs it, and nothing otherwise; a failure of it prints nothing.
#   - Then the JSON is posted, in the background, with nothing of its output on the status line:
#     the token goes to curl on a pipe, never on a command line; only to this computer (the
#     origin must be loopback, and no proxy is used); at most two seconds; every failure is
#     silence. Of what it sends, this module keeps numbers, the session id and the model's name.

dir=$(/usr/bin/dirname "$0")
here=$dir/kehikot
own=$(/bin/cat "$here/statusline" 2>/dev/null)
compose=
[ -n "$own" ] || compose=$(/bin/cat "$here/compose" 2>/dev/null)
shell=/bin/bash
[ -x "$shell" ] || shell=/bin/sh

umask 077
held=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/kehikot-status.XXXXXX" 2>/dev/null) || held=
if [ -z "$held" ]; then
  # Nowhere to keep the JSON: the person's line still runs, as it would without this module.
  if [ -n "$own" ]; then exec "$shell" -c "$own"; fi
  if [ -n "$compose" ] && [ -x "$compose" ]; then cd "$dir" 2>/dev/null && exec "$compose" ./statusline-line.mjs 2>/dev/null; fi
  exec /bin/cat >/dev/null
fi
/bin/cat >"$held"

said=0
if [ -n "$own" ]; then
  "$shell" -c "$own" <"$held"
  said=$?
elif [ -n "$compose" ] && [ -x "$compose" ]; then
  # From the plugin folder, so that a runtime reads no bunfig.toml or .env of the project's.
  (cd "$dir" 2>/dev/null && exec "$compose" ./statusline-line.mjs) <"$held" 2>/dev/null
fi

(
  token=$(/bin/cat "$here/token" 2>/dev/null)
  origin=$(/bin/cat "$here/origin" 2>/dev/null)
  curl=/usr/bin/curl
  sed=/usr/bin/sed
  ok=1
  case $token in '' | *[!A-Za-z0-9_-]*) ok=0 ;; esac
  [ ${#token} -le 64 ] || ok=0
  [ -x "$curl" ] && [ -x "$sed" ] || ok=0
  session=$(/usr/bin/head -c 262144 "$held" | /usr/bin/tr -d '\n\r' | "$sed" -n 's/.*"session_id" *: *"\([0-9a-f-]\{36\}\)".*/\1/p')
  case $session in '' | *[!0-9a-f-]*) ok=0 ;; esac
  post() {
    case $1 in http://127.0.0.1:[0-9]*) ;; *) return 1 ;; esac
    printf 'header = "x-module-ticket: %s"\n' "$token" |
      "$curl" -q --config - --silent --fail --max-time 2 --connect-timeout 1 --noproxy '*' \
        --header 'content-type: application/json' --data-binary @"$held" \
        --request POST "$1/api/status?session=$session" >/dev/null 2>&1
  }
  if [ "$ok" = 1 ] && ! post "$origin" && [ -f "$here/registration" ]; then
    # The module may have moved to another port since this session started; its registration says where.
    reg=$(/bin/cat "$here/registration" 2>/dev/null)
    if [ -f "$reg" ]; then
      url=$("$sed" -n 's/.*"url"[[:space:]]*:[[:space:]]*"\(http:\/\/127\.0\.0\.1:[0-9]*\)".*/\1/p' "$reg" | /usr/bin/head -n 1)
      [ -n "$url" ] && [ "$url" != "$origin" ] && post "$url"
    fi
  fi
  /bin/rm -f "$held"
) </dev/null >/dev/null 2>&1 &

exit $said
