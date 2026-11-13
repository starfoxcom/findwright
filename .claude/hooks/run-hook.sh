#!/bin/sh
# Starts one of this repo's guard hooks: sh run-hook.sh <name>
# Claude Code pipes the tool call to stdin as JSON; the hook reads it there.
#
# The tool call goes ahead on purpose (exit 0) when:
# - ~/.claude/hooks/<name>.py exists and ~/.claude/settings.json names it
#   outside a permission rule, so the user's own copy runs and the check
#   never runs twice (a registration whose file is gone does not count);
# - no Python 3.8+ outside a virtual environment is on PATH;
# - this folder holds no hook file <name>.py.
#
# A hook that starts and then crashes, times out or exits with a code other
# than 0 or 2 is not handled here: the settings entry sets "onFailure":
# "block", so Claude Code blocks the tool call.
#
# A committed file cannot name the interpreter by absolute path, so this
# looks for one. A virtual environment's interpreter is refused because it
# can belong to the project. Python runs with -I, so the project's own
# modules cannot replace the ones the hook imports.

name=$1
hook="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/$name.py"

settings="$HOME/.claude/settings.json"
# Permission entries look like "Bash(...)": a mention inside one is no
# registration. A line is dropped when the name sits inside such a string
# anywhere on it (compact arrays, minified files), so a line holding both a
# registration and a permission counts as neither and the hook runs twice,
# the safe side.
path="hooks[/\\\\]+$name\\.py"
if [ -f "$HOME/.claude/hooks/$name.py" ] && [ -f "$settings" ] &&
  grep -E "$path" "$settings" | grep -Evq "\"[A-Za-z]+\\(([^\"\\\\]|\\\\.)*$path"; then
  exit 0
fi

[ -f "$hook" ] || exit 0

for py in python3 python py; do
  if "$py" -I -c 'import sys; sys.exit(sys.version_info < (3, 8) or sys.prefix != sys.base_prefix)' >/dev/null 2>&1; then
    exec "$py" -I -c 'import runpy, sys; runpy.run_path(sys.argv[1], run_name="__main__")' "$hook"
  fi
done

echo "Guard hook $name did not run: no Python 3.8+ found outside a virtual environment." >&2
exit 0
