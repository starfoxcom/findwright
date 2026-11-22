#!/usr/bin/env python3
"""PreToolUse guard: nothing authored from a Claude session carries AI
attribution when it is written the ordinary way.

Rule (.claude/rules/git.md): commits, PR titles and bodies, issue bodies,
comments, reviews, releases and tags belong to the maintainer. The harness
can inject a note asking for attribution trailers; this hook is the
mechanical answer so the note can never win.

The contract is "no attribution", not "no mention". Denied: a Co-Authored-By
naming an AI, an Anthropic noreply address, "Generated with / written by
<AI>", a line ending "via Claude Code" or "by Claude", a Claude Code session
link or Claude-Session trailer, a session id, "AI-assisted / AI-generated"
and the robot emoji. Plain mentions pass: "fix the Claude Code hook config",
"compatible with Claude Code", "integration with LLM providers", CLAUDE.md,
the repo's own name, a human Co-Authored-By.

What is scanned, for any git write, gh write or GitHub API call:
  * The full command text: inline -m / --body / --title / --notes values,
    here-docs, here-strings and PowerShell -Body all live there.
  * Every file a command names with a body flag (-F / --file / --template
    for a git write, -F at the end of a cluster (-aF), and -t for git
    commit; --body-file / --notes-file / --input / -F and
    --field key=@file; -d @file and -F key=@file; -InFile; Get-Content's
    path). Bindwright's helper parses the command the way the shell does
    (`hooks/shell-words.mjs`), so each flag belongs to one
    command. A brace of plain text is read both as text built at run time
    and as the words bash makes of it (`{-F,msg.txt}` as `-F msg.txt`),
    since a shell may or may not expand it. Every command's flags are read, a wrapper's (`env`, `sudo`,
    `xargs`) included, except a text tool's (`awk -F,`, `grep -F word`),
    git's in a read (`git log -F`), and gh's `--template`. A flag inside
    quoted text, a here-doc, a here-string or the value of -m / --body /
    --title is text, not a body file. A relative path is read in the start
    folder and in every folder a `cd` (`builtin cd` and `command cd` too),
    `pushd`, `Set-Location`, `git -C` or `env -C` / `--chdir` in the
    command names, each reached from the folders named before it in
    the text, since one may run in a child shell or fail, then again until
    no folder is added, since a loop or a function may run one again. One
    after a folder change it cannot place (`cd -`, a
    target built at run time, a folder this computer cannot find) is
    denied. A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. A program built
    at run time has every file flag of its command read. A shell's options
    are never read: each argument of `bash`, `sh`, `zsh` and the like whose
    text names a write or a hook change is parsed and read like the command,
    up to three shells deep; one built at run time or nested deeper is
    denied, as is a nested `pwsh` or `powershell` whose text arguments name
    one, since PowerShell joins them into a script (but a script block
    after options alone is read with the command, and words after a `.ps1`
    file are its parameters). A shell named at run time, or a word after
    git, gh or a text tool first or after `sudo`-like wrappers, is not read.

The parser is required: it runs on Node 18 or later from Bindwright's
helper, which setup installs with this guard. A command this hook reads is
denied when either is missing, when the helper is older than this hook, or
when the parser cannot read the command (an array built at run time,
PowerShell's `--%`, syntax it rejects), with a reason that names the fix.

Also denied, since the hook cannot see past them, for a git program (a
word built at run time that names git, such as `$GIT`, counts as one): a
write that skips git's own hooks (`--no-verify`, `-n` on commit or am),
setting or unsetting `core.hooksPath` or a `hook.` setting (`git config`,
`-c`, `--config-env`; reading one passes), `--trailer`, a commit that
reuses another commit's message (`-C`, `-c`, `--reuse-message`,
`--reedit-message`), and turning lefthook off (`LEFTHOOK=0` or `false` set
by the command, `lefthook uninstall`), and a git call whose subcommand
comes from a word built at run time with no literal word other than an
option written right after it (`git "${args[@]}"`, `git "$@" -m x`,
PowerShell's `git @args`), or from a word before it that may become several
(`git -C "$@"`, `git --namespace="$@"`) unless only git's own options stand
between that word and a subcommand written out (`git -C $d --no-pager log`). Options are read as git reads them, bundled
(`-nm x`) or shortened (`--no-veri`), so a message that names one passes.
A word built at run time counts for the literal text around its run-time
parts (`--trailer=$WHO`, `"-C$SHA"`, `"$S.hooksPath"`), and one
that can expand to no word (`$OPTS`, `"$@"`) is also read as absent.

It is a safety net for attribution written the ordinary way, not a sandbox
against a command built to slip past it. No text check can be one. These
pass unread: message text the shell builds at run time ($VAR, $(...),
backticks, eval), a body file the command itself writes, a body piped in
on stdin, a git alias or a git program built at run time whose text does
not name git (their options are not read as git's), an option, setting or
`git config` name whose text the shell builds at run time (`${X:+-n}`,
`$(echo --no-verify)`, `"$KEY"`, `core.ho$'o'ksPath`), a body-file flag
the shell builds at run time from a word that does not start with `-` as
written (`$F` holding `-F msg.txt`), a script PowerShell decodes
(`-EncodedCommand`), a git named at run time whose subcommand is built too
(`$GIT "$@"`), one inside `bash -c` whose subcommand is built, one built
at run time and followed right away by a literal word such as a pathspec
(`git "$@" .`), one with a built subcommand behind a program other than
the shell's wrappers and the common runners (`flock f git "$@"`; `sudo`,
`env`, `timeout`, `stdbuf` and the like are read), a write whose text a
redirection holding `&` splits
(`git 2>&1 commit`, `git 2>&1 "$@"`), and text a program
started by the command writes on its own. The repo's `attribution` settings
switch off the harness's own trailers; this hook catches the ones written
by hand.

Its reading lives in the no_ai_attribution/ folder beside it, which ships
and installs with it. The repo registers this file through run-hook.sh, which skips it when
~/.claude/hooks/no-ai-attribution.py exists and ~/.claude/settings.json
names it outside a permission rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent
exit 0 otherwise. A read-only command is blocked only for the routes above,
or when the parser it needs is missing or cannot read it.
"""
import importlib.util
import json
import os
import re
import sys
import time


# Obfuscation-tolerant: optional zero-width / separator chars between letters.
_Z = r"[​‌‍⁠﻿\s\-_.*]*"


def _fuzzy(word):
    return _Z.join(re.escape(ch) for ch in word)


CLAUDE = _fuzzy("claude")
ANTHROPIC = _fuzzy("anthropic")
# Tool names that make a phrase attribution. `cursor` alone is an ordinary UI
# word ("pointer with cursor"), so only "Cursor AI / IDE / agent" counts.
AI = (r"(?:" + CLAUDE + "|" + ANTHROPIC + r"|ai|llm|assistant|copilot|codex|chat" + _Z + r"gpt|gpt|gemini|"
      r"cursor" + _Z + r"(?:ai|ide|agent))")
AN = r"(?:an?" + _Z + r")?"

# Bindwright's own Attribution workflow imports ATTRIBUTION and strip_paths from
# this file: keep both names, and keep importing it free of side effects (main()
# runs only as a script).
ATTRIBUTION = re.compile(
    "|".join([
        # Co-Authored-By naming an AI; a human co-author passes.
        # No two separator runs touch: `-` is one of them, and two in a row make a long run of
        # separators take time that grows with its length squared. For the same reason the
        # blank lines after `by` and the rest of its line are two runs that share no character.
        r"co" + _Z + r"authored" + _Z + r"by(?:\s*\n)?[^\n]*?\b" + AI + r"\b",
        r"noreply@" + ANTHROPIC,
        r"\b(?:generated|written|created|made|authored|produced|assisted|co-?written)" + _Z
        + r"(?:with|by|using|via)" + _Z + r"(?::" + _Z + r")?" + AN + AI + r"\b",
        # Trailer forms with a colon: "Assisted-by: <AI>:<model>", "Made-with: Cursor".
        r"\b(?:generated|written|created|made|authored|produced|assisted|co-?written)" + _Z
        + r"(?:with|by|using|via)" + _Z + r":[ \t]*" + AN + r"(?:" + AI + r"|cursor)\b",
        # A line or quoted message that ends "via Claude Code" / "by Claude".
        # Not "with" / "using": "compatible with Claude Code" is a mention.
        r"\b(?:by|via)" + _Z + CLAUDE + r"(?:" + _Z + r"code)?(?=[\s.!)\]]*(?:$|['\"`]))",
        r"claude\.(?:ai|com)/(?:code|claude-code)\b",
        r"\b" + CLAUDE + r"[-_]session\s*:",
        r"session_[0-9a-z]{20,}",
        r"\U0001F916",                       # robot emoji
        r"\bai" + _Z + r"(?:assisted|generated|written|authored)",
    ]), re.I | re.M)
# A subcommand is a whole word: one inside a path or a name (`.claude/hooks/push-guard.py`,
# `commit-msg`) names no write.
_WORD_START = r"(?<![\w./\\:-])"
_WORD_END = r"(?![\w./-])"
# One command of a line: the text between `|`, `;`, `&` and line ends.
_SEGMENT = re.compile(r"[^|;&\n]+")


def _in_order(*patterns):
    """A test of text: each pattern matches after the one before it, inside one segment. The
    earliest match of each is enough, so it runs in linear time, where one pattern joined by
    lazy runs takes time that grows with the cube of a long line's length."""
    compiled = [re.compile(p, re.I) for p in patterns]

    def test(text):
        for segment in _SEGMENT.finditer(text):
            at = segment.start()
            for pattern in compiled:
                hit = pattern.search(text, at, segment.end())
                if not hit:
                    break
                at = hit.end()
            else:
                return True
        return False
    return test


def _word(alternatives):
    return _WORD_START + "(?:" + alternatives + ")" + _WORD_END


GIT_WRITE = _in_order(r"\bgit\b", _word(
    "commit-tree|commit|merge|push|tag|notes|am|cherry-pick|revert|rebase|replace"))
GH_WRITE = _in_order(r"\bgh\b", _word("pr|issue|release|gist|repo"),
                     _word("create|edit|comment|review|merge|close|reopen"))
# A git call that may take its subcommand from a word built at run time (`git "${args[@]}"`,
# PowerShell's `git @args`): a `$` or backtick anywhere after git (`--namespace="$@"`), or a word
# starting with `@` or `(`. It only sends the command to the parser, whose reading decides; a
# command the parser cannot read is not refused for it.
GIT_BUILT = _in_order(r"\bgit(?:\.(?:exe|cmd|bat|com))?\b", r"[$`]|[ \t][\"']?[@(]")
GH_API = _in_order(r"\bgh\b", _word("api"))
HTTP_GH = _in_order(r"\b(?:curl|Invoke-(?:RestMethod|WebRequest))\b", r"api\.github\.com")
# Commands that may change which hooks run without writing anything.
GIT_CONFIG_HOOKS = _in_order(r"\bgit\b", r"\bconfig\b", r"hook|--re[mn]|\bre(?:move|name)-section\b")
LEFTHOOK_SET = re.compile(r"\blefthook\b\W*=", re.I)
LEFTHOOK_UNINSTALL = _in_order(r"\blefthook\b", r"\buninstall\b")
# A line end the shell joins to the next: `\` (an even run of `\` escapes itself) or
# PowerShell's backtick after a blank.
CONTINUED_LINE = re.compile(r"(?<!\\)((?:\\\\)*)\\\r?\n|(?<=[ \t])`\r?\n")
# Text bash rewrites before a program sees it: a backslash escape or an ANSI-C or locale
# string can spell any word, so the text checks cannot rule such a command out.
SHELL_ESCAPES = re.compile(r"\\|\$['\"]")

PATH_TOKEN = re.compile(r"(?<!:/)(?<![\w])(?:[A-Za-z]:|~)?(?:[\\/][\w.\-]+)+")
ALL_PARSES_SECONDS = 27  # every parse of one command, nested strings included: the hook is stopped at 30 s
BYPASS_REASONS = {
    "hooks": "git hook bypass (--no-verify / -n) is not allowed.",
    "setting": ("setting core.hooksPath or a hook. setting changes which hooks git runs;"
                " ask the user to run it."),
    "trailer": "--trailer is not allowed; write the message body directly.",
    "reuse": "reusing another commit's message (-C / -c / --reuse-message) cannot be scanned.",
    "lefthook": "turning lefthook off removes the commit-msg attribution check.",
    "unread": ("this git call has more words built at run time than the guard reads every way;"
               " split it, or write some of them out."),
    "built": ("this git call takes its subcommand from a word built at run time (`git \"${args[@]}\"`),"
              " which may hold a commit and its options; write the subcommand out."),
}


def deny(reason):
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "BLOCKED (no AI attribution): " + reason
                + " Commits, PRs, issues, comments and releases belong to the maintainer; no AI "
                  "Co-Authored-By, no generated-with line, no session link, no robot emoji.",
        }
    }))
    sys.exit(0)


def strip_paths(text):
    """Mask file-system paths so a scratch directory named after a session
    cannot trip the scan. URLs survive (the lookbehind skips the `//` after a
    scheme), so session links are still caught."""
    return PATH_TOKEN.sub("<path>", text)


def scan_text(text, where):
    hit = ATTRIBUTION.search(strip_paths(text))
    if hit:
        deny(f"attribution marker '{hit.group(0).strip()}' found in {where}.")


def routes_in(text):
    """(writes, names a route, may build git's subcommand): whether text names a git or GitHub
    write, a hook change, or a git call with a word built at run time after it, as written, with
    line ends joined, and without quotes (`com'mit'`) or escapes (`g\\it`)."""
    joined = CONTINUED_LINE.sub(r"\1", text)
    texts = (text, joined, re.sub(r"[\"'`]", "", joined), re.sub(r"[\"'`\\]", "", joined))
    writes = any(test(t) for test in (GIT_WRITE, GH_WRITE, GH_API, HTTP_GH) for t in texts)
    named = writes or any(test(t) for test in (GIT_CONFIG_HOOKS, LEFTHOOK_SET.search, LEFTHOOK_UNINSTALL)
                          for t in texts)
    return writes, named, any(GIT_BUILT(t) for t in texts)


def readers(named):
    """The package's readers, loaded only here so the Attribution workflow can import this file
    alone; without the package, a command that names a route is refused, as without the parser."""
    sys.dont_write_bytecode = True  # no __pycache__ beside a hook a repo may commit
    here = os.path.dirname(os.path.abspath(__file__)).replace("\\", "/")
    # Loaded by its own path, never through sys.path, so no other file beside the hook can stand
    # in for a module the guard imports.
    folder = os.path.join(here, "no_ai_attribution")
    spec = importlib.util.spec_from_file_location(
        "no_ai_attribution", os.path.join(folder, "__init__.py"), submodule_search_locations=[folder])
    try:
        package = sys.modules["no_ai_attribution"] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(package)
        package.routes_in = routes_in
        from no_ai_attribution.files import parsed_files
        from no_ai_attribution.routes import hook_route
        from no_ai_attribution.shell import parse, with_nested
    except (ImportError, OSError):
        if named:
            deny("the folder no_ai_attribution/ beside this guard, which reads the command, is missing."
                 " Copy it back from Bindwright's helper: `cp -r ~/.bindwright/helper/node_modules/bindwright"
                 f"/_core/global-template/hooks/no_ai_attribution \"{here}/\"` (`helper/python/bindwright`"
                 " after a pip install), or `git checkout -- .claude/hooks/no_ai_attribution` where the"
                 " repo commits it.")
        sys.exit(0)
    return parse, with_nested, parsed_files, hook_route


def parse_reason(cmd, shell, named, built):
    """Why a command goes to the parser: "routes" when its text names a route or it is an
    escaped bash command, "built" when it only may build git's subcommand, None when it does not.
    An escaped command is refused only for what the parser's words show, so a parser that cannot
    read it refuses nothing new; a "built" one is refused only for a built subcommand."""
    if named or shell == "bash" and SHELL_ESCAPES.search(cmd):
        return "routes"
    return "built" if built else None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except Exception:
        sys.exit(0)
    tool_input = data.get("tool_input") if isinstance(data, dict) else None
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str):
        sys.exit(0)  # not a shell call this guard can read: let it through
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    writes, named, built = routes_in(cmd)
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    reason = parse_reason(cmd, shell, named, built)
    if not reason:
        sys.exit(0)
    parse, with_nested, parsed_files, hook_route = readers(named)

    if writes:
        scan_text(cmd, "the command text")
    deadline = time.monotonic() + ALL_PARSES_SECONDS
    parsed, assignments, problem = parse(cmd, shell, cwd, deadline)
    found = []  # A nested string is read only when it names a route, so its problems all refuse.
    if not problem:
        groups, assignments, problem = with_nested(parsed, assignments, shell, cwd, deadline, found)
    if problem:
        if named or found:
            deny(problem)
        sys.exit(0)
    for text in (t for t in found if routes_in(t)[0]):
        writes = True
        scan_text(text, "a command string a shell runs")
    # A command that writes nothing is checked only for the routes past the hooks.
    for path, error in (parsed_files(groups, cwd) if writes else ()):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.")
        scan_text(text, f"file {path}")
    route = hook_route(groups, assignments, reason == "built")
    if route:
        deny(BYPASS_REASONS[route])
    sys.exit(0)

if __name__ == "__main__":
    main()
