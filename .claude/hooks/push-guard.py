r"""PreToolUse hook: block force pushes that permission rules cannot see.

Permission rules match command text, so `-f` bundled with other short flags
(`-qf`, `-vf`, `-uqf`) escapes them. This hook reads the text of every Bash
and PowerShell command and blocks a git push that carries:

- `--force` or `-f`, alone or inside a short-flag bundle;
- `--mirror` (or a prefix of it), which force-updates and deletes every
  remote ref;
- a refspec starting with `+`, a force push of that one ref;
- `-c remote.<name>.push=+...` or a true `-c remote.<name>.mirror`;
- a one-off alias for push (`git -c alias.p='push -f' p`).

`--force-with-lease` and `--force-if-includes` stay allowed: they refuse to
overwrite work the local repo has not seen. The same checks cover git's push
plumbing, `send-pack` and `http-push`, and the dashed `git-push` programs.

It is a safety net for force pushes written the ordinary way, not a sandbox
against a command built to slip past it: no text check can be one, since a
program started by the command can push on its own.

The hook reads text, not shell grammar. First it removes what the shell
would remove: line continuations, quotes, backslashes and backticks,
decoding Bash's `$'...'` escapes when the string closes on its own line
(the result stays one word) and PowerShell's `` `u{...} `` on the way. Each
command substitution (`$(...)`, `$((...))`, `${...}`, `<(...)`, a Bash
backtick pair on one line, a PowerShell `(...)`) is read on its own. In the
text around it, a substitution inside a word joins the text on both sides
(`-q$(true)f` reads as `-qf`) and one at a word's edge leaves a word; a
PowerShell group of quoted literals (`@('push','-qf')`) stays in place as
arguments. The rest is cut into
statements at every newline, and at every `;`, `|` and `&` that is neither
escaped nor inside a quoted string that closes on its own line (in
PowerShell also at `{` and `}`). Redirects and their targets are dropped,
except a target that names git (`bash <<< "git push -f"`). After a `git`
word, a later push word in the same statement starts the push, and the
words after it are its arguments. Text inside `eval`, `sh -c`,
`pwsh -Command`, a heredoc or a comment is read the same way. Each shell's
own line continuation is removed. Git Bash drops every carriage return first,
so a Bash command holding one is also read without them. Bash keeps a `\`
ending a comment, a single-quoted line or a quoted heredoc line as a line
end instead, so a Bash command with a `\` ending a line is read whole: with
each such `\` joined and with it kept as a line end, and each reading also
as one statement, so a push anywhere in it with a force word anywhere after
it blocks. Every step is linear in the command's length.

That includes text that only mentions a force push: a commit message, a
script or a search pattern with `git push -f` in it is blocked too. So is a
plain push in a Bash command with a `\` ending a line when a force word
follows anywhere in it (`git push origin main \` then `&& rm -rf build`). A
plain push chained after a quoted string that spans lines can block the same
way: on the string's last line its closing quote pairs with the next quote,
so the flag of a later statement there (`rm -rf`) reads as the push's. The
block message says to put such text in a file and pass the file instead,
and to put a command with a `\` ending a line on one line or run its push as
a command of its own.

The hook only ever blocks or stays silent; it never asks. Out of reach, so
these run without a block:

- a force flag the shell builds at run time (`git push $FLAGS`,
  `$(echo -qf)`, `xargs`, brace expansion, text piped into a shell or
  `iex`, `('-q'+'f')`, PowerShell's `-f` format operator as in
  `("+{0}" -f $b)`, PowerShell's `--%`);
- git config or aliases that force a later plain `git push`, whether on
  disk (`git config alias.p 'push -f'`, a `remote.<name>.push` or `mirror`
  setting) or set in the same command (`GIT_CONFIG_*` variables,
  `--config-env`);
- git reached by another name: a variable (`G=git; $G push -f`; `$GIT` and
  `${GIT:-git}` are read as git), a shell alias or `Set-Alias`, `hash -p`,
  or a glob (`gi[t]`);
- remote branch and tag deletions, and a branch deleted and then pushed
  again;
- a push run by another program (`python -c`, `node -e`, `make`, `gh api`,
  `git fetch --upload-pack`);
- a push after a git option value with spaces in it, one of whose later
  words is exactly a git subcommand in OTHER_SUBCOMMANDS (`git -C "My notes
  dir" push -f`): the search for the push word stops there;
- shell syntax this reading takes differently from the shell, where that
  cuts a push off from its `git` word or its force flag: quotes paired
  differently (a quoted string that spans lines, a `$(`, `${` or backtick
  inside single quotes, as in `echo '$('; git push origin main ')' -f`), or
  parentheses left unbalanced inside a substitution;
- a command over MAX_COMMAND characters.

Project deny rules cover some of these by text (`git remote *--mi*`, `gh repo
sync *--force*`). Input that is not JSON and any error while reading a
command let the call through.

It runs from one of two places. Installed in `~/.claude/hooks/`, setup
registers it in `~/.claude/settings.json` only after finding a Python 3.8+
interpreter outside any virtual environment, naming both the interpreter and
this file by absolute path, in exec form (`command` plus `args`), so no shell
and no `python3`/`python`/`py` guess is involved. Shipped in a repo's
`.claude/hooks/`, the committed settings start it through `run-hook.sh`,
which cannot know an absolute interpreter path: it takes the first of
`python3`, `python` and `py` that is Python 3.8+ outside a virtual
environment, and skips this file when `~/.claude/hooks/push-guard.py`
exists and `~/.claude/settings.json` names it outside a permission
rule. A project that ships it this way must keep tokensave's hook global:
tokensave copies the launcher of a project's existing hooks into its own
project entries, and `sh run-hook.sh` is no launcher for it.
Either way it runs through a `runpy` one-liner instead of
`python <path>` because Python exits 2 when it cannot open a script, which
would block every call. Both launchers test that the file exists first, so a
missing file lets the call proceed. The interpreter runs with `-I`, so the
project directory (the hook's working directory) is not on the import path and a
repo's own `json.py` cannot replace the modules this file imports.
"""
import json
import re
import sys

# Longer commands pass unread. Every step below is linear in the command's
# length, so this only bounds the work; no real push command comes near it.
MAX_COMMAND = 100000
# Innermost substitutions are cut out one nesting level per pass.
MAX_PASSES = 64

PUSH_SUBCOMMANDS = {"push", "send-pack", "http-push"}
PUSH_PROGRAMS = {"git-push", "git-send-pack", "git-http-push"}
# git subcommands that never push; after one, a later push word is its text.
OTHER_SUBCOMMANDS = {
    "add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "checkout",
    "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff", "fetch", "for-each-ref",
    "format-patch", "gc", "grep", "help", "init", "log", "ls-files", "ls-remote", "merge", "mv",
    "notes", "pull", "rebase", "reflog", "remote", "reset", "restore", "rev-list", "rev-parse",
    "revert", "rm", "shortlog", "show", "stash", "status", "submodule", "switch", "tag", "worktree"}
# git's own options that take the next word as their value; that word is
# never the subcommand (`git -C ../notes push -f`).
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
                     "--super-prefix", "--config-env", "--attr-source"}

CONTINUATION = {"Bash": re.compile(r"\\\n"), "PowerShell": re.compile(r"`(?:\r\n|\n|\r)")}
# A `$'...'` string, found after skipping escapes and quoted strings the way
# `mask_quoted` pairs them, so the `$'` ending `grep 'main$'` starts nothing.
ANSI_QUOTE = re.compile(r"\\.|\"(?:[^\"\\\n]|\\.)*\"|'[^'\n]*'|\$'((?:[^'\\\n]|\\[^\n])*)'", re.S)
# Bash's `$'...'` escapes: hex, `\u` and `\U` with as few digits as Bash
# takes, octal, control characters, and single letters.
ANSI_ESCAPE = re.compile(
    r"\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c(.)|(.))", re.S)
ANSI_LETTERS = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n", "r": "\r",
                "t": "\t", "v": "\v", "\\": "\\", "'": "'", "\"": "\"", "?": "?"}
# What a decoded `$'...'` holds is one word to the shell around it, so its
# separators and quotes never split or pair anything there.
ANSI_SEPARATORS = re.compile(r"[;|&\n\r{}\"'`]")
POWERSHELL_CHAR = re.compile(r"`u\{([0-9A-Fa-f]{1,6})\}")
# A parenthesis, or `case`/`esac` where Bash reads it as a keyword: at a
# command's start (`x=$(case ...`, `; case`, `then case`), never as an
# argument (`echo in case`, `--ignore-case`).
CASE_TOKEN = re.compile(r"[$<>]?\(|\)|(?:^|(?<=[;&|({\n])|(?<=\bthen)|(?<=\bdo)|(?<=\belse))[ \t]*case(?=\s)"
                        r"|(?<![^\s;&|])esac(?![^\s;&|)])", re.M)
# PowerShell runs any `(...)` as its own expression (`("v{0}" -f $n)`).
# Bash arithmetic `$((...))` is cut out whole, so its `+` is no refspec; a
# bare `(...)` (a subshell, an arithmetic group) is cut out on its own. A
# group that still holds a `$(` or `${` waits a pass, so the innermost
# substitution is always cut first (`("${TICKET}-fix")`).
_PARENS = r"([^()$]*(?:\$(?![({])[^()$]*)*)"
_BRACES = r"([^{}$]*(?:\$(?![({])[^{}$]*)*)"
INNERMOST = {"Bash": re.compile(r"\$\(\(" + _PARENS + r"\)\)|[$<>]?\(" + _PARENS + r"\)|\$\{" + _BRACES + r"\}"),
             "PowerShell": re.compile(r"[$@]?\(" + _PARENS + r"\)|\$\{" + _BRACES + r"\}")}
BACKTICK_GROUP = re.compile(r"`([^`\n]*)`")
# A PowerShell group of quoted literals, `@('push', '--force')`: its words are
# the command's own arguments.
LITERAL_GROUP = re.compile(r"\s*(?:'[^'\n]*'|\"[^\"$`\n]*\")(?:\s*,\s*(?:'[^'\n]*'|\"[^\"$`\n]*\"))*\s*")
# An escaped character outside quotes, a quote, or a line end.
QUOTE_OR_LINE = {"Bash": re.compile(r"\\.|[\"'\n]", re.S), "PowerShell": re.compile(r"`.|[\"'\n]", re.S)}
# A quoted string from its opening quote to a close on the same line.
QUOTED = {"Bash": {"\"": re.compile(r"\"(?:[^\"\\\n]|\\.)*\""), "'": re.compile(r"'[^'\n]*'")},
          "PowerShell": {"\"": re.compile(r"\"(?:[^\"`\n]|`.)*\""), "'": re.compile(r"'[^'\n]*'")}}
# A lone carriage return and a brace end a statement only in PowerShell
# (`{ git push -u origin x } else { Write-Host 'skip' -f Yellow }`).
STATEMENT_END = {"Bash": re.compile(r"[\n;|&]"), "PowerShell": re.compile(r"[\n\r;|&{}]")}
# The statement ends that a quote or an escape turns into plain text.
QUOTED_SEPARATORS = {"Bash": re.compile(r"[;|&]"), "PowerShell": re.compile(r"[;|&{}]")}
WORD_SPLIT = re.compile(r"[\s<>,]+")
# A redirect operator and its target, read once quotes are gone. A target
# never starts with `-` or `+`, so `--repo=">" -qf` and `-o "x>" +main` keep
# their force words.
REDIRECT = re.compile(r"(?<![0-9])[0-9]*(?:&>>?|>&|<&|>>?\|?|<)[ \t]*((?:[^\s;|&<>\-+][^\s;|&<>]*)?)")
EDGE = "(){}[]$&!@"
QUOTE_CHARS = "\"'‘’“”"
# git push has no upper-case short option, and a bundle with one fails before
# anything is pushed, so `-Leaf` and `-Filter` are not push flags.
SHORT_OPTIONS = re.compile(r"-[a-z0-9]+")
LONG_FORCE = re.compile(r"--force(?:=.*)?|--m(?:i(?:r(?:r(?:o(?:r)?)?)?)?)?")
# git reads a mirror value as true unless it is false, no, off or a zero
# number (`mirror=2` and `mirror=1k` are true). An empty value counts as
# true here: it is what is left of a quoted value with a leading space
# (`"remote.origin.mirror= 1"`).
FORCING_CONFIG = re.compile(
    r"remote\..+\.push=\+.*|remote\..+\.mirror(?:=(?!(?:false|no|off|[-+]?(?:0x)?0+[kmg]?)$).*)?", re.I)
# A `!` alias may run the dashed program, by name or path (`!git-push -f`).
PUSH_ALIAS = re.compile(
    r"alias\.[^=]+=(?:push|send-pack|http-push|!(?:\S*/)?(?:git-)?(?:push|send-pack|http-push))", re.I)


def ansi_char(match):
    """One `$'...'` escape as Bash decodes it; an unknown one stays as it is."""
    hex_code, short, long, octal, control, letter = match.groups()
    code = hex_code or short or long
    if code:
        return chr(min(int(code, 16), 0x10FFFF))
    if octal:
        return chr(int(octal, 8) & 0xFF)
    if control is not None:
        return chr(ord(control) & 0x1F)
    return ANSI_LETTERS.get(letter, "\\" + letter)


def ansi_decode(match):
    """The text of Bash's `$'...'`, decoded, as one word; anything else the
    pattern skipped stays as it is."""
    if match.group(1) is None:
        return match.group(0)
    return ANSI_SEPARATORS.sub(" ", ANSI_ESCAPE.sub(ansi_char, match.group(1)))


def neutral_cases(text):
    """The text with each `)` that ends a Bash `case` pattern turned into a
    space, so it never closes a substitution around it. A `)` that closes a
    `(`, `$(`, `<(` or `>(` opened after the `case` stays, so substitutions
    inside a case arm are read like any other."""
    out, last, stack, cases = [], 0, [], 0
    for match in CASE_TOKEN.finditer(text):
        token = match.group(0).lstrip(" \t")
        if token == "case":
            stack.append(token)
            cases += 1
        elif token == "esac":
            if cases:
                while stack.pop() != "case":
                    pass
                cases -= 1
        elif token != ")":
            stack.append("(")
        elif stack and stack[-1] == "(":
            stack.pop()
        elif stack:
            out += [text[last:match.start()], " "]
            last = match.end()
    out.append(text[last:])
    return "".join(out)


def stand_in(match, literal=False):
    """What a substitution leaves in the text around it: a PowerShell group
    of quoted literals as it is (`@('push','-qf')`), `git` when it names git
    (`& ("git") push`, `$(which git) push`), otherwise a plain word. A
    substitution inside a word joins the text on both sides (`-q$(true)f`
    reads as `-qf`); one at a word's edge leaves a word there (`+$(git
    branch)` and `"+${BRANCH}"` read as `+x`)."""
    inner = next(g for g in match.groups() if g is not None)
    if literal:
        return f" {inner} "
    text, start, end = match.string, match.start(), match.end()
    # A quote that opens or closes the word is its edge: `-C "${REPO}"` leaves
    # a word, `"${USER}-feature"` reads as `x-feature`, `-q"$(true)"f` as `-qf`.
    # So is the `(` or `,` before it and the `)` or `,` after it in a
    # PowerShell group (`("${TICKET}-fix")` reads as `x-fix`).
    before, after = start - 1, end
    while before >= 0 and text[before] in QUOTE_CHARS:
        before -= 1
    while after < len(text) and text[after] in QUOTE_CHARS:
        after += 1
    left = before >= 0 and not text[before].isspace() and text[before] not in "(,"
    right = after < len(text) and not text[after].isspace() and text[after] not in "),"
    if re.search(r"(?i)\bgit(?:\.exe)?\s*$", unquote(inner, "path")):
        word = "git"
    else:
        word = "" if left and right else "x"
    return ("" if left else " ") + word + ("" if right else " ")


def texts(command, tool):
    """The command's pieces: each command substitution on its own, then the
    rest with each substitution replaced by a word; and whether substitutions
    are nested past MAX_PASSES."""
    # Each shell's own line continuation: Bash joins `\` + LF with nothing
    # between, PowerShell reads a backtick before a line end as a space. A
    # backtick ending a Bash line and a `\` ending a PowerShell path stay.
    s = CONTINUATION[tool].sub(" " if tool == "PowerShell" else "", command)
    if tool != "PowerShell":
        s = neutral_cases(ANSI_QUOTE.sub(ansi_decode, s))
    else:
        s = POWERSHELL_CHAR.sub(lambda m: chr(min(int(m.group(1), 16), 0x10FFFF)), s)
    pieces = []
    if tool != "PowerShell":
        pieces += BACKTICK_GROUP.findall(s)
        s = BACKTICK_GROUP.sub(stand_in, s)
    for _ in range(MAX_PASSES):
        out, last = [], 0
        for match in INNERMOST[tool].finditer(s):
            inner = next(g for g in match.groups() if g is not None)
            literal = tool == "PowerShell" and LITERAL_GROUP.fullmatch(inner) is not None
            # A literal group stays in the text, so it is not read again here.
            if not literal:
                pieces.append(inner)
            out += [s[last:match.start()], stand_in(match, literal)]
            last = match.end()
        if not out:
            break
        out.append(s[last:])
        s = "".join(out)
    pieces.append(s)
    return pieces, INNERMOST[tool].search(s) is not None


def mask_quoted(text, tool):
    """The text with `;`, `|` and `&` inside quotes turned into spaces, so a
    quoted value (`-C "C:/R&D"`) stays in its statement. Only a quote that
    closes on its own line counts, so neither an apostrophe in a heredoc
    body or comment nor the closing quote of a string that spans lines can
    join statements. An escaped character outside quotes (`\\;`, `` `; ``,
    `\\"`) is text: it neither splits a statement nor opens a quote.

    Each character is read once: a quote with no close on its line means no
    later quote of that kind on the line closes either, so those are passed
    over instead of each searching to the end of the line again."""
    out, pos, unclosed = [], 0, set()
    while True:
        found = QUOTE_OR_LINE[tool].search(text, pos)
        if not found:
            break
        mark, at = found.group(0), found.start()
        if len(mark) == 2:
            out += [text[pos:at], mark[0] + QUOTED_SEPARATORS[tool].sub(" ", mark[1])]
            pos = found.end()
            continue
        if mark == "\n":
            unclosed.clear()
        elif mark not in unclosed:
            quoted = QUOTED[tool][mark].match(text, at)
            if quoted:
                out += [text[pos:at], QUOTED_SEPARATORS[tool].sub(" ", quoted.group(0))]
                pos = quoted.end()
                continue
            unclosed.add(mark)
        out.append(text[pos:at + 1])
        pos = at + 1
    out.append(text[pos:])
    return "".join(out)


def unquote(text, backslash):
    """The text without quote characters, backticks and `$` before a quote;
    a backslash is dropped (an escape) or read as a path separator."""
    text = re.sub(r"\$(?=[\"'])", "", text)
    text = re.sub("[\"'`\u2018\u2019\u201c\u201d]", "", text)
    return text.replace("\\", "/" if backslash == "path" else "")


def name(word):
    """The program a word names: its last path part, lowercased, without
    `.exe`."""
    return re.sub(r"\.exe$", "", word.strip(EDGE).split("/")[-1].lower())


def forces(word):
    """Whether one push argument forces: `--force`, a `--mirror` prefix, or a
    short-option bundle with `f` in it (`-qf`, `-4f`)."""
    if word.startswith("--"):
        return LONG_FORCE.fullmatch(word) is not None
    return "f" in word and SHORT_OPTIONS.fullmatch(word) is not None


def force_in(words):
    """Why the words of one statement force-push, or None. After a `git`
    word, a later push word starts the push, whatever sits between them: an
    option value split at its spaces (`-C "/c/My Repo"`) or a substitution's
    stand-in word. So does a one-off alias for push (`-c alias.p='push -f'
    p`), whose arguments follow its name. A word that is exactly a git
    subcommand in OTHER_SUBCOMMANDS, and is not the value of a git option,
    ends the search."""
    git, pushing, forcing, value = False, False, None, False
    for raw in words:
        word = raw.strip(EDGE)
        if pushing:
            if forces(word):
                return f"`{word}`"
            if word.startswith("+"):
                return f"`{word}` (a leading + forces that ref)"
            continue
        if value:
            value = False
            if FORCING_CONFIG.fullmatch(word):
                forcing = f"`-c {word}`"
            elif PUSH_ALIAS.fullmatch(word):
                pushing = True
            continue
        program = name(word)
        if program in PUSH_PROGRAMS:
            pushing = True
        elif program == "git":
            git = True
        elif not git:
            continue
        elif word in GIT_VALUE_OPTIONS:
            value = True
        elif FORCING_CONFIG.fullmatch(word):
            forcing = f"`-c {word}`"
        elif program in PUSH_SUBCOMMANDS or PUSH_ALIAS.fullmatch(word):
            if forcing:
                return forcing
            pushing = True
        elif word in OTHER_SUBCOMMANDS:
            # Another git command: its arguments are its own (`git commit -m
            # "push -f later"`).
            git, forcing = False, None
    return None


def redirect_gone(match):
    """What a redirect leaves: nothing, or its target when that names git, as
    in `bash <<< "git push -qf"`, which feeds the text to a shell."""
    target = match.group(1)
    return f" {target} " if name(target) == "git" or name(target) in PUSH_PROGRAMS else " "


def check(command, tool):
    """Why a command's text force-pushes, or None."""
    if len(command) > MAX_COMMAND:
        return None
    if tool == "Bash" and "\r" in command:
        # Git Bash drops every CR before reading, so `\` + CR + LF continues a
        # line there; Bash elsewhere keeps the CR. Either reading can block.
        return check_bash(command) or check_bash(command.replace("\r", ""))
    return check_bash(command) if tool == "Bash" else check_reading(command, tool)


def check_bash(command):
    """Why a Bash command's text force-pushes, or None."""
    tool = "Bash"
    if "\\\n" in command:
        # Bash does not continue a comment (`# C:\work\repo\`), a single-quoted
        # string or a quoted heredoc body, and telling those apart means
        # parsing Bash. Such a command is read whole instead, once with each
        # `\` + LF joined and once with it kept as a line end, each also as one
        # statement: a push anywhere in it with a force anywhere after blocks.
        for reading in (command, command.replace("\\\n", " \n")):
            reason = check_reading(reading, tool, whole=True)
            if reason:
                return reason
        return None
    return check_reading(command, tool)


def check_reading(command, tool, whole=False):
    """Why one reading of a command's text force-pushes, or None."""
    pieces, deep = texts(command, tool)
    for piece in pieces:
        masked = mask_quoted(piece, tool)
        for backslash in ("escape", "path"):
            # Redirects go once quotes are gone, so `git>/dev/null push` and
            # `push&>/dev/null` read as `git push`.
            text = REDIRECT.sub(redirect_gone, unquote(masked, backslash))
            # Substitutions nested past MAX_PASSES may hide separators, so such
            # a command is also read as one statement.
            # Read as one statement, the separators become spaces so a word
            # glued to one (`-f;`, `-qf|tail`) stays a word.
            whole_text = [STATEMENT_END[tool].sub(" ", text)] if deep or whole else []
            for statement in STATEMENT_END[tool].split(text) + whole_text:
                reason = force_in([w for w in WORD_SPLIT.split(statement) if w])
                if reason:
                    return reason
    return None


def main():
    try:
        # Claude Code writes UTF-8. Decode it as UTF-8 instead of the platform's
        # default encoding.
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return 0
    tool = data.get("tool_name") if isinstance(data, dict) else None
    if tool not in ("Bash", "PowerShell"):
        return 0
    try:
        reason = check((data.get("tool_input") or {}).get("command") or "", tool)
    except Exception:
        # An error is not a certain force push.
        return 0
    if reason:
        print(f"Blocked a force push: {reason}. Use `--force-with-lease` instead, which refuses "
              "to overwrite commits you have not fetched. If the command only mentions a force "
              "push (a message, a script, a search), put that text in a file and pass the file. "
              "If it has a `\\` ending a line, put it on one line or run the push as its own "
              "command.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
