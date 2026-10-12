#!/bin/sh
# A stand-in for the vendor's installer: prints, waits a little, and puts the
# stand-in `claude` where the real installer puts the real one —
# `$HOME/.local/bin/claude`. `fail` as the first argument makes it the
# installer that does not finish. Never run against a real home: the tests
# and the walk give it a scratch one.
here=$(cd "$(dirname "$0")" && pwd)
echo "stand-in installer: downloading…"
sleep 1
if [ "$1" = "fail" ]; then
  echo "stand-in installer: the download failed (this is the failing variant)"
  exit 7
fi
mkdir -p "$HOME/.local/bin"
cp "$here/claude" "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
echo "stand-in installer: installed to $HOME/.local/bin/claude"
