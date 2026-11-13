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
    for a git write; --body-file / --notes-file / --input / -F and
    --field key=@file; -d @file and -F key=@file; -InFile; Get-Content's
    path). Bindwright's helper parses the command the way the shell does
    (tree-sitter, `hooks/shell-words.mjs`), so each flag belongs to one
    command. Every command's flags are read, a wrapper's (`env`, `sudo`,
    `xargs`) included, except a text tool's (`awk -F,`, `grep -F word`),
    git's in a read (`git log -F`), and gh's `--template`. A flag inside
    quoted text, a here-doc, a here-string or the value of -m / --body /
    --title is text, not a body file. A relative path is read in the start
    folder and in every folder a `cd`, `pushd`, `Set-Location` or `git -C`
    in the command names, each reached from the folders named before it in
    the text, since one may run in a child shell or fail. A `cd` a loop or
    a function runs again, or before one written earlier, is not followed
    further. One after a folder change it cannot place (`cd -`, a
    target built at run time, a folder this computer cannot find) is
    denied. A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. A command the
    parser is unsure of (a program or an array built at run time,
    PowerShell's `--%`, syntax it cannot read) and one run without the helper or Node get the strict
    read instead: every file flag in the command text, a text tool's and
    one inside quoted text included, and a relative body file after any
    `cd`, `pushd`, `Set-Location` or `git -C` is denied. So flag-like text
    in such a command's message (`$GIT commit -m "--file=x"`) is denied too.

It is a safety net for attribution written the ordinary way, not a sandbox
against a command built to slip past it. No text check can be one. These
pass unread: message text the shell builds at run time ($VAR, $(...),
backticks, eval), a body file the command itself writes, a body piped in
on stdin, a message reused from another commit
(-C / --reuse-message), flags that skip git's own hooks, and text a program
started by the command writes on its own. The repo's `attribution` settings
switch off the harness's own trailers; this hook catches the ones written
by hand.

The repo registers this file through run-hook.sh, which skips it when
~/.claude/hooks/no-ai-attribution.py exists and ~/.claude/settings.json
names it outside a permission rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent
exit 0 otherwise. Never blocks read-only commands.
"""
import json
import os
import re
import shutil
import subprocess
import sys

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
        r"co" + _Z + r"-?" + _Z + r"authored" + _Z + r"-?" + _Z + r"by\s*:?[^\n]*?\b" + AI + r"\b",
        r"noreply@" + ANTHROPIC,
        r"\b(?:generated|written|created|made|authored|produced|assisted|co-?written)" + _Z
        + r"(?:with|by|using|via)" + _Z + r":?" + _Z + AN + AI + r"\b",
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
        r"\bai" + _Z + r"-?" + _Z + r"(?:assisted|generated|written|authored)",
    ]),
    re.I | re.M,
)

# A subcommand is a whole word: one inside a path or a name (`.claude/hooks/push-guard.py`,
# `commit-msg`) names no write.
_WORD_START = r"(?<![\w./\\:-])"
_WORD_END = r"(?![\w./-])"
GIT_WRITE = re.compile(
    r"\bgit\b[^|;&\n]*?" + _WORD_START
    + r"(commit-tree|commit|merge|push|tag|notes|am|cherry-pick|revert|rebase|replace)"
    + _WORD_END, re.I)
GH_WRITE = re.compile(
    r"\bgh\b[^|;&\n]*?" + _WORD_START + r"(pr|issue|release|gist|repo)" + _WORD_END + r"[^|;&\n]*?"
    + _WORD_START + r"(create|edit|comment|review|merge|close|reopen)" + _WORD_END, re.I)
GH_API = re.compile(r"\bgh\b[^|;&\n]*?" + _WORD_START + r"api" + _WORD_END, re.I)
HTTP_GH = re.compile(r"\b(?:curl|Invoke-(?:RestMethod|WebRequest))\b[^|;&\n]*api\.github\.com", re.I)

# Without the parser: flags whose next token is a file the hook must read. `-F`
# is case-sensitive: a lowercase `-f` is `git tag -f` (force) or `gh pr create
# -f` (fill). Long flags match whole (`--filename` is not `--file`). The value
# may follow a space or the long-option `=` (`--body-file=body.md`).
FILE_FLAGS = re.compile(
    r"(?:(?<=\s)-F"
    r"|(?P<long>(?i:--file|--body-file|--notes-file|--template|--input|--message-file|--field|-InFile))(?![\w-])"
    r"|(?i:Get-Content)(?:\s+(?i:-Raw|-Path|-LiteralPath)(?![\w-]))*"
    r"|(?<=\s)-d\s*@|(?i:--data(?:-binary|-raw)?)\s*@)"
    r"\s*=?\s*(?:\"(?P<dq>[^\"]+)\"|'(?P<sq>[^']+)'"
    r"|(?P<kv>[^\s=\"']+=@(?:\"[^\"]+\"|'[^']+'))|(?P<bare>\S+))"
)
PATH_TOKEN = re.compile(r"(?<!:/)(?<![\w])(?:[A-Za-z]:|~)?(?:[\\/][\w.\-]+)+")

# With the parser: every command's file flags are read, except a text tool's, git's
# in a read (where -F or --file means something else) and gh's `--template` (a template
# name). Any other git subcommand, an alias included, is read as a write. A wrapper (`env`,
# `sudo`, `xargs`) or any other program has its flags read.
GIT_READS = {"grep", "log", "show", "whatchanged", "rev-list", "shortlog", "reflog", "diff", "blame",
             "status", "config", "clone", "init", "ls-files", "for-each-ref", "cat-file", "check-ignore"}
GIT_FILE_FLAGS = {"-F", "--file", "--template"}
GIT_WORD = re.compile(r"\bgit\b", re.I)  # `$GIT`, `$(command -v git)`
FORM_FLAGS = {"-F", "--field", "--form"}  # key=value is a field; key=@file reads a file
DATA_FLAGS = {"-d", "--data", "--data-binary", "--data-raw"}  # only @file reads a file
BODY_FLAGS = {"--file", "--body-file", "--notes-file", "--input", "--message-file", "--template",
              "-infile"} | FORM_FLAGS | DATA_FLAGS
# The word after one of these is message text, even when it starts with a dash. Each
# program has its own: `-m` is git's message but gh's `--merge` switch.
GIT_MESSAGE_FLAGS = {"-m", "--message"}
MESSAGE_FLAGS = {"-b", "--body", "-t", "--title", "--notes", "--subject", "--message"}
GH_MESSAGE_FLAGS = MESSAGE_FLAGS | {"-n"}  # gh's -n is --notes; git's is a switch
# `-am msg`: git's switches, then -m takes the next word. The first letter that takes a value
# takes the rest of the word instead (`-mcalm` is the message "calm"). Besides m, these
# lowercase letters take one in each git write that has -m (`git <subcommand> -h`); an alias
# or a subcommand built at run time may be any of them.
GIT_VALUE_LETTERS = {"commit": "ctu", "tag": "u", "notes": "c", "merge": "s", "commit-tree": "p"}
ANY_VALUE_LETTERS = "cpstu"
ATTACHED = ("-F", "-d")  # short flags read with a value written onto them (`-Fmsg`, `-d@body`)
TEXT_TOOLS = {"awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq",
              "head", "tail", "wc", "jq", "column", "paste", "join", "select-string", "sls", "findstr"}
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
HOME_COMMANDS = {"cd", "chdir", "set-location", "sl"}  # alone, each goes home
CD_COMMANDS = HOME_COMMANDS | {"pushd", "popd", "push-location", "pop-location"}
PARSE_SECONDS = 6  # the hook itself is stopped at 10 s
STRICT_READ = (" so it read every file flag, a text tool's (awk -F, grep -F) included: run that tool"
               " as a command of its own.")
NO_HELPER_HINT = (" Without Bindwright's helper (`/bindwright:update` installs it), the guard cannot"
                  " read the command's structure," + STRICT_READ)
NO_NODE_HINT = (" The guard reads a command's structure with a parser that runs on Node 18 or later,"
                " which this computer lacks (install it to stop these refusals)," + STRICT_READ)
UNREAD_HINT = " The guard could not read this command's structure," + STRICT_READ
MOVES_FOLDER = re.compile(r"(?<![\w-])(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)"
                          r"(?![\w-])|\bgit\b[^|;&\n]*?\s(?-i:-C)(?![\w-])", re.I)  # -c sets config


def deny(reason):
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
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


def parser_script():
    """The shell parser in Bindwright's helper, which setup installs per computer with npm
    or pip; None when neither copy is there."""
    helper = os.path.join(os.path.expanduser("~"), ".bindwright", "helper")
    folders = [os.environ.get("BINDWRIGHT_HELPER")] if os.environ.get("BINDWRIGHT_HELPER") else [
        os.path.join(helper, "node_modules", "bindwright"), os.path.join(helper, "python", "bindwright")]
    scripts = [os.path.join(folder, "hooks", "shell-words.mjs") for folder in folders]
    return next((script for script in scripts if os.path.isfile(script)), None)


def node_program(cwd):
    """The `node` on PATH, or None when the only one is the session folder's own. On Windows a
    bare name is looked up in the current folder first, so a repo could ship its own
    `node.exe`: that search is switched off, and a match that is relative (a `.` on PATH) or
    sits in the session folder is refused."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    found = shutil.which("node")
    if not found or not os.path.isabs(found):
        return None
    here = {os.path.normcase(os.path.realpath(folder)) for folder in (cwd, os.getcwd())}
    return None if os.path.normcase(os.path.realpath(os.path.dirname(found))) in here else found


def parse(cmd, shell, cwd):
    """(each simple command's words, as the shell reads them (helper/hooks/shell-words.mjs),
    and "". When the parser is missing, fails or is unsure of the command: None, and the
    hint that says which."""
    node, script = node_program(cwd), parser_script()
    if not node:
        return None, NO_NODE_HINT
    if not script:
        return None, NO_HELPER_HINT
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=PARSE_SECONDS)
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, UNREAD_HINT
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("commands"), list):
        return None, UNREAD_HINT
    return data["commands"], ""


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def flag_values(words, short=(), message_flags=MESSAGE_FLAGS, value_letters=None):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}. The word after one of `message_flags` is that message's text,
    never a flag. With `value_letters`, so is the word after a git cluster ending in -m whose
    earlier letters take no value."""
    cluster = re.compile(r"-(?:(?![m%s])[a-z])*m" % value_letters) if value_letters is not None else None
    message = False
    for i, word in enumerate(words):
        text = text_of(word)
        if message or not text.startswith("-"):
            message = False
            continue
        built = isinstance(word, dict)
        message = (text in message_flags or text.lower() == "-body"  # PowerShell names are any case
                   or (cluster is not None and cluster.fullmatch(text) is not None))
        if text.startswith("--") and "=" in text:
            flag, value = text.split("=", 1)
        elif text[:2] in short and len(text) > 2:
            flag, value = text[:2], text[2:]
        elif built:
            continue
        else:
            yield word, words[i + 1] if i + 1 < len(words) else None
            continue
        yield flag, {"dynamic": value} if built else value


def body_file(flag, value, readers="@<"):
    """The file a body flag's value names, a run-time word whose file cannot be told, or None.
    A form field reads a file when its value, after the first `=`, starts with one of
    `readers`: `@` for gh, `@` or `<` for curl."""
    text = text_of(value)
    if flag in FORM_FLAGS and "=" in text:
        field = text.split("=", 1)[1]
        if not field.lstrip("\"'")[:1] or field.lstrip("\"'")[:1] not in readers:
            return None
        return value if isinstance(value, dict) else field[1:]
    if flag in DATA_FLAGS:
        if not text.lstrip("\"'").startswith("@"):  # curl -d reads a file only after @
            return None
        return value if isinstance(value, dict) else text[1:]
    return value


def body_files(words, flags=BODY_FLAGS, message_flags=MESSAGE_FLAGS, readers="@<", value_letters=None):
    """Every file the words' flags in `flags` name as a body."""
    files = []
    for flag, value in flag_values(words, ATTACHED, message_flags, value_letters):
        name = flag.lower() if isinstance(flag, str) and flag.lower() == "-infile" else flag
        if isinstance(name, str) and name in flags and value is not None:
            found = body_file(name, value, readers)
            if found is not None:
                files.append(found)
    return files


def git_subcommand(words):
    """(index of git's subcommand, the folders its `-C` options name, in order)."""
    folders, i = [], 1
    while i < len(words) and text_of(words[i]).startswith("-"):
        if isinstance(words[i], str) and words[i] in GIT_VALUE_OPTIONS and i + 1 < len(words):
            if words[i] == "-C":
                folders.append(words[i + 1])
            i += 1
        i += 1
    return i, folders


def git_files(words):
    """The body files of any git subcommand but a read. When the subcommand is built at run
    time (`git $OPTS commit`), every file flag after it is read."""
    i = git_subcommand(words)[0]
    if i >= len(words) or (isinstance(words[i], str) and words[i] in GIT_READS):
        return []
    return body_files(words[i:], GIT_FILE_FLAGS, GIT_MESSAGE_FLAGS, value_letters=git_value_letters(words))


def git_value_letters(words):
    """The lowercase letters other than m that take a value in this git command's subcommand."""
    i = git_subcommand(words)[0]
    subcommand = words[i] if i < len(words) and isinstance(words[i], str) else None
    return GIT_VALUE_LETTERS.get(subcommand, ANY_VALUE_LETTERS)


def get_content_files(words):
    files = [v for f, v in flag_values(words) if isinstance(f, str)
             and f.lower() in ("-path", "-literalpath") and v is not None]
    positional = [w for w in words[1:] if not (isinstance(w, str) and w.startswith("-"))]
    return files or positional[:1]


def resolve(value, places):
    """(path, error) for each file a body flag's value may name, or an error saying why it
    cannot be told before the command runs. A relative file is read in each of `places`
    that holds it, or in the first when none does; `places` is None after a folder change
    the command text cannot place."""
    if isinstance(value, dict):
        yield None, f"a body file named by text the shell builds at run time ({value.get('dynamic')})"
        return
    path = os.path.expanduser(value)
    if os.path.isabs(path):
        yield path, None
    elif places is None:
        yield None, (f"a relative body file {value} after a folder change the command text cannot tell"
                     " (such as `cd -`, a target built at run time or a folder this computer cannot find)")
    else:
        paths = [os.path.join(place, path) for place in places]
        yield from ((found, None) for found in [p for p in paths if os.path.isfile(p)] or paths[:1])


def command_files(words):
    """The body files one command names."""
    name = program(words)
    if name in TEXT_TOOLS:
        return []
    if name == "git":
        return git_files(words)
    if name == "gh":
        return body_files(words, BODY_FLAGS - {"--template"}, GH_MESSAGE_FLAGS, "@")
    if name in READ_CMDLETS:
        return get_content_files(words)
    # Every flag is read. A word naming git, gh or Get-Content may be a wrapped program (`env
    # A=1 git commit`, `sudo gh ...`, `pwsh -Command Get-Content x`) or just an argument
    # (`sudo -u git`, a URL ending in /gh), so each is also read with its own rules, and only
    # its own exceptions (gh's --template, git's -m) are taken off the outer read.
    inner = [words[i:] for i in range(1, len(words)) if program(words[i:]) in {"git", "gh"} | READ_CMDLETS]
    names = {program(run) for run in inner}
    # git's own reads take its --template; elsewhere it names one, unless a word built at run
    # time names git (`timeout 5 $GIT commit`), as the strict read judges it. Then git's -m is
    # a message too.
    built_git = any(is_run_time_git(w) for w in words)
    flags = BODY_FLAGS if built_git else BODY_FLAGS - {"--template"}
    message = MESSAGE_FLAGS | (GIT_MESSAGE_FLAGS if "git" in names or built_git else set())
    letters = None if "git" not in names and not built_git else "".join(
        [ANY_VALUE_LETTERS] * built_git + [git_value_letters(run) for run in inner if program(run) == "git"])
    readers = "@" if "gh" in names else "@<"  # gh reads a form field's file only after =@
    return (body_files(words, flags, message, readers, letters)
            + [f for run in inner for f in command_files(run)])


def folder_targets(words):
    """The folders one command names to move to: a `cd`-style command's targets (home for a
    bare `cd`, none for `popd` or a bare `pushd`), or the `-C` folders of a git it runs."""
    name = program(words)
    if name in CD_COMMANDS:
        targets = [w for w in words[1:] if text_of(w) == "-" or not text_of(w).startswith("-")]
        return targets or (["~"] if name in HOME_COMMANDS else [])
    return [folder for i in range(len(words)) if program(words[i:]) == "git" or is_run_time_git(words[i])
            for folder in git_subcommand(words[i:])[1]]


def is_run_time_git(word):
    """Whether a word built at run time names git (`$GIT`, `$(command -v git)`), as the strict
    read judges a command."""
    return isinstance(word, dict) and GIT_WORD.search(text_of(word)) is not None


def folder_places(commands, cwd):
    """Every folder a command may run in: the start folder, and each folder a folder change
    in the command names, reached from any folder found before it in the text, since a `cd`
    may run in a child shell or fail, so the shell may be in any of them. None when a target
    cannot be placed: one built at run time, or one this computer cannot find, such as a
    saved folder (`cd -`, `~-`), a Git Bash path (`/c/...`) or a folder made later."""
    places = [cwd]
    for words in commands:
        for target in folder_targets(words):
            if not isinstance(target, str):
                return None
            path = os.path.expanduser(target)
            reached = [path] if os.path.isabs(path) else [os.path.join(place, path) for place in places]
            found = [place for place in reached if os.path.isdir(place)]
            if not found:
                return None
            places += [place for place in found if place not in places]
    return places


def parsed_files(commands, cwd):
    """(path, error) for every body file the parsed commands name, in order, a relative one
    read in every folder the command may run in."""
    places = folder_places(commands, cwd)
    for words in commands:
        for value in command_files(words):
            if value != "-":
                yield from resolve(value, places)


def strict_files(cmd, cwd):
    """Without the parser: every file flag in the command text, a text tool's included. A
    relative file after a folder change (`cd`, `git -C`) cannot be placed, so it is refused."""
    moved = MOVES_FOLDER.search(cmd) is not None
    for m in FILE_FLAGS.finditer(cmd):
        path = m.group("dq") or m.group("sq") or m.group("kv") or m.group("bare")
        if not path or path == "-":
            continue
        if (m.group("long") or "").lower() == "--template":
            # A file for `git commit`; a template name or repository for gh.
            stage = cmd[max(cmd.rfind(c, 0, m.start()) for c in ";&|\n") + 1:m.start()]
            if not re.search(r"\bgit\b", stage, re.I):
                continue
        if "=" in path:            # gh -F key=value / key=@file
            if "=@" not in path:
                continue
            path = path.split("=@", 1)[1]
            if path == "-":        # key=@- reads stdin
                continue
        path = os.path.expanduser(path.strip("\"'"))
        if os.path.isabs(path):
            yield path, None
        elif moved:
            yield None, f"a relative body file {path} after a change of folder"
        else:
            yield os.path.join(cwd, path), None


def scan_text(text, where):
    hit = ATTRIBUTION.search(strip_paths(text))
    if hit:
        deny(f"attribution marker '{hit.group(0).strip()}' found in {where}.")


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
    if not cmd or not (GIT_WRITE.search(cmd) or GH_WRITE.search(cmd) or GH_API.search(cmd)
                       or HTTP_GH.search(cmd)):
        sys.exit(0)

    scan_text(cmd, "the command text")
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    parsed, hint = parse(cmd, shell, cwd)
    for path, error in (parsed_files(parsed, cwd) if parsed is not None else strict_files(cmd, cwd)):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.{hint}")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.{hint}")
        scan_text(text, f"file {path}")
    sys.exit(0)


if __name__ == "__main__":
    main()
