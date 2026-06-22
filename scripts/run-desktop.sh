#!/bin/bash
# Helper to launch the desktop dev workflow with node + node_modules/.bin on PATH.
# Required because git-bash does not propagate the user's Windows PATH to spawned
# cmd.exe children the way npm-script-launched shells do.
set -e
cd "$(dirname "$0")/.."
# Prepend node + node_modules/.bin so concurrently's children (spawned via cmd.exe)
# can resolve `vite`, `tsx`, etc., while keeping git-bash builtins on PATH.
export PATH="/c/Program Files/nodejs:$PWD/node_modules/.bin:$PATH"
WIN_PATH="$(cygpath -w -p "$PATH" 2>/dev/null || echo "$PATH")"
export PATH="$WIN_PATH"
exec ./node_modules/.bin/concurrently --kill-others-on-fail -n renderer,electron \
  "vite --config vite.desktop.config.ts" \
  "tsx src/desktop/launcher.ts"
