#!/usr/bin/env python3
"""PreToolUse guard: refuse the shell patterns a session was told to stop using. After a commit or
PR command (PostToolUse), it also notes a commit subject or PR title that landed over its limit.

Each rule in RULES names a pattern that keeps failing, why, and what to use
instead. A correction of the kind "never use X, use Y" lands here as a new rule,
so the session cannot drift back to X: a note in memory alone does not hold.

Rules other than the inline-script one read the command with quoted strings
and PowerShell here-string bodies taken out, and a bash command only as far as
its first here-document, so a commit message or a PR body that only mentions a
pattern passes. The inline-script rule reads a bash command's first
here-document, only when its `<<` stands outside quotes, and PowerShell
here-strings, and refuses one only where an interpreter reads its script from
standard input (`python -`, `cat <<EOF | node`): fed to a script file, the text
is data. It also reads the script of a `python -c` or `node -e` call that
stands outside quotes and comments. Where the reading is unsure (a quote that
never closes, a double-quoted string holding `$(`, a `<<` inside one), the
text is left unread: a missed pattern costs less than a refused command. It is
a safety net for the ordinary spelling, not a sandbox against a command built
to slip past it. Two rows also read the repo: the merge-style row its saved
answers, and the changelog row the staged CHANGELOG.md against the last
commit's, as git stores them.

The length notes parse no command: after one that mentions `git commit` or
`gh pr create` or `edit`, they read the subject or title that landed from git
and gh themselves, so every spelling and shell is covered.

Each rule carries its mode. An `enforce` rule refuses the command. An `observe`
rule only appends what it would have refused to the user's Bindwright folder
(OBSERVED_LOG), which `/bindwright:doctor` reports, so a false refusal shows up
before anyone is stopped. A new rule ships as `observe` and moves to `enforce`
in a later release once its log shows none, unless the command it stops cannot
be undone (a repo secret write): that one enforces from the start. The mode
lives here, never in a file a session could write, so nothing at run time
relaxes a rule.

Exit contract: before a command, JSON permissionDecision=deny on stdout, exit 0;
after one, JSON additionalContext with the length notes, exit 0. Silent exit 0
otherwise, and for any input it cannot read.
"""
import bisect
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

INTERPRETER = r"(?:python3?|py|node|deno|bun|perl|ruby|php|bash|sh|zsh|pwsh|powershell)(?:\.exe)?"
PROGRAM = re.compile(r"(?:.*[/\\])?" + INTERPRETER, re.I)
# The short-option letters that hand each interpreter its script some other way (`python -Ic`,
# `perl -ne`, `php -r`), so standard input is data; short letters are never abbreviated.
SCRIPT_LETTERS = {"python": "cm", "py": "cm", "node": "ep", "bun": "e", "perl": "eE", "ruby": "e",
                  "php": "rf", "bash": "c", "sh": "c", "zsh": "c"}
SCRIPT_LONG = {"--eval", "--print", "--command", "--file"}
POWERSHELL_SCRIPT = {"-c", "-command", "-f", "-file", "-e", "-ec", "-encodedcommand"}
SHELLS = ("bash", "sh", "zsh")
REDIRECTION = re.compile(r"\d*(?:&>|[<>]&?)")
# A here-document opener, its word quoted (`<<'EOF'`, `<<"EOF"`), escaped (`<<\EOF`) or bare.
HEREDOC = re.compile(r"<<(-?)[ \t]*\\?(['\"]?)([A-Za-z_][\w-]*)\2")
# A `<<` that is not part of a here-string (`<<<`); `without_arithmetic` blanks arithmetic, where a
# `<<` opens nothing.
HEREDOC_OPERATOR = re.compile(r"(?<!<)<<(?!<)")
# A PowerShell here-string: `@'` or `@"` and any blanks to the end of the line, the body (none when
# the closing line comes next), then the first line that starts with the same quote and `@`.
HERE_STRING_PARTS = r"@({quotes})[ \t]*\r?\n(?:(.*?)\r?\n)??\1@"
HERE_STRING = re.compile(HERE_STRING_PARTS.format(quotes="['\"]") + r"([^\n]*)", re.S)
# The separators between the commands of one line, a lone `&` (run in the background) among them
# but not a redirection (`2>&1`, `&>f`) or `|&`; a pipe joins two parts of one command.
LIST_SEPARATOR = re.compile(r"&&|\|\||;|(?<![>&|])&(?![>&])")
# `python -c '...'`, `node -e "..."`: the script text, as far as its closing quote.
INLINE = re.compile(r"(?:^|[\s;&|(])(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c[ \t]+(['\"])(.*?)\1"
                    r"|(?:^|[\s;&|(])node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print)[ \t]+(['\"])(.*?)\3",
                    re.I | re.S)
INLINE_CALL = re.compile(r"(?:^|[\s;&|(])(?:(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c"
                         r"|node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print))[ \t]+['\"]", re.I)
# Comments, quoted strings and escapes as each shell reads them, in one pass across lines, so
# whichever starts first wins: a `#` that starts a word outside quotes comments out the rest of
# its line, and a quote character in a comment opens nothing. Bash escapes with a backslash,
# PowerShell with a backtick and by doubling the quote, and a PowerShell backslash is plain text
# (`"C:\"`). A PowerShell block comment runs from `<#` to the first `#>`. Bash's `$'...'` ends
# only at an unescaped quote. A quote or block comment that never closes, and a double-quoted
# string holding `$(`, whose own quotes nest, run to the end of the command. A PowerShell
# here-string (`@'` to a line starting `'@`) is one more quoted string in the same scan, so one
# inside a message or a comment is part of that text.
COMMENT = r"(?:^|(?<=[\s;&|(]))#[^\n]*"
QUOTED = {"bash": re.compile(COMMENT + r"|\\.|\$'(?:[^'\\]|\\.)*(?:'|\Z)|'[^']*(?:'|\Z)"
                             r"|\"(?:[^\"\\$]|\\.|\$(?!\())*\$\(.*|\"(?:[^\"\\]|\\.)*(?:\"|\Z)", re.S)}
POWERSHELL_QUOTED = (r"<#.*?(?:#>|\Z)|" + COMMENT + r"|`.|'(?:[^']|'')*(?:'|\Z)"
                     r"|\"(?:[^\"`$]|`.|\"\"|\$(?!\())*\$\(.*|\"(?:[^\"`]|`.|\"\")*(?:\"|\Z)")
# The PowerShell scan for each set of quotes whose here-strings may still close. An opener with
# no closing line after it never matches, and trying one reads to the end of the command, so the
# scan leaves those out: many of them would take time that grows with the command's length squared.
POWERSHELL_SCANS = {quotes: re.compile((HERE_STRING_PARTS.format(quotes="[%s]" % quotes) + "|" if quotes else "")
                                       + POWERSHELL_QUOTED, re.S) for quotes in ("'\"", "'", "\"", "")}
# Where any part of the PowerShell scan can start.
POWERSHELL_QUOTE_START = re.compile(r"[@<#`'\"]")
# Git Bash's path conversion is what mangles a dot-led rev path; other shells pass it as written.
GIT_BASH = os.name == "nt"
# A `jq` call: a word of its own, not the `--jq` option of `gh`.
JQ = re.compile(r"(?:^|(?<=[\s;&|(]))jq(?:\.exe)?(?=\s|$)")

WRITE_THE_FILE = "its backslashes get eaten. Write the script with the Write tool, then run the file."


def blanked(match):
    """The matched text as spaces, line ends kept, so the positions around it stay put."""
    return re.sub(r"[^\n]", " ", match.group())


def as_quote(match):
    """A quoted string as its opening quote and spaces, a comment or an escape as spaces, line
    ends kept, so the text keeps its length, a call's position in it matches the original's, and
    the quote a script starts with stays where it is, whatever follows it."""
    spaces = blanked(match)
    if match.group()[:1] in "'\"":
        return match.group()[0] + spaces[1:]
    return spaces


def without_arithmetic(text):
    """The text with each `((...))` and `$((...))` blanked, where a `<<` opens nothing: an opener
    closes at the first `)` after it when a second `)` follows. That `)` is found once and kept for
    every opener before it, since searching from each opener takes time that grows with the square
    of a long run of `(`."""
    parts, at, look, close = [], 0, 0, -1
    while True:
        opener = text.find("((", look)
        if opener == -1:
            break
        if close < opener + 2:
            close = text.find(")", opener + 2)
            if close == -1:
                break
        start = opener - 1 if opener > at and text[opener - 1] == "$" else opener
        if text.startswith(")", close + 1):
            parts += [text[at:start], re.sub(r"[^\n]", " ", text[start:close + 2])]
            at = look = close + 2
        else:
            look = opener + 1
    return "".join(parts) + text[at:]


def as_word(match):
    """A quoted string as one placeholder word the length of the original, line ends kept, so a
    quoted argument (`python3 "$HOOK"`) still counts as a word."""
    return re.sub(r"^[^\n]", "Q", blanked(match))


def first_opener(text):
    """(line number, match) of the first line that may open a here-document, quoted or not, or
    None: a `<<` that is not part of a here-string (`<<<`) followed by a word."""
    for number, line in enumerate(text.split("\n")):
        for operator in HEREDOC_OPERATOR.finditer(line):
            match = HEREDOC.match(line, operator.start())
            if match:
                return number, match
    return None


def heredoc(text):
    """(receivers, body) of a bash command's first here-document, or None when it has none or its
    `<<` stands inside quotes, a comment or arithmetic, where the reading is unsure
    (`"$(cat <<'EOF'`). The receivers are the commands of its pipeline from the one the `<<` feeds
    on (`cat <<EOF | python3`), with quoted strings blanked."""
    first = first_opener(text)
    if not first:
        return None
    number, match = first
    masked = without_arithmetic(QUOTED["bash"].sub(as_word, text)).split("\n")[number]
    if not HEREDOC_OPERATOR.match(masked, match.start()):
        return None
    before = LIST_SEPARATOR.split(masked[:match.start()])[-1].split("|")[-1]
    after = LIST_SEPARATOR.split(masked[match.end():])[0].split("|")
    body = []
    for line in text.split("\n")[number + 1:]:
        if ends_heredoc(line, match):
            break
        body.append(line)
    return [before + after[0]] + after[1:], "\n".join(body)


def ends_heredoc(line, match):
    """Whether a line is the terminator of the here-document `match` opened."""
    line = line.rstrip("\r")
    return (line.lstrip("\t") if match.group(1) else line) == match.group(3)


def program_words(command):
    """A command's words without the `NAME=value` assignments before or among them."""
    return [word for word in command.split() if not re.fullmatch(r"\w+=\S*", word)]


def interpreter_name(word):
    """`python3.exe` and `/usr/bin/python3` as `python`: the key the option tables use."""
    return re.sub(r"\d+$", "", re.sub(r"(?i)\.exe$", "", re.split(r"[/\\]", word)[-1]).lower())


def gives_script(word, name):
    """Whether an option hands the interpreter its script itself (`-c`, `-ne`, `--eval=...`)."""
    if word.startswith("--"):
        return word.split("=", 1)[0].lower() in SCRIPT_LONG
    if name in ("pwsh", "powershell"):
        return word.lower() in POWERSHELL_SCRIPT
    return any(letter in word[1:] for letter in SCRIPT_LETTERS.get(name, ""))


def reads_script(command):
    """Whether this command is an interpreter that reads its script from standard input: nothing
    but options after it (`python`, `node`), `-`, or `-s` for a shell. A script file, a module or
    an inline script (`python3 x.py`, `python -m pkg`, `perl -ne '...'`) reads standard input as
    data, and so does an option whose value is unknown (`python -W x`); a script option given `-`
    (`pwsh -Command -`) reads it from standard input after all."""
    words = program_words(command)
    if not words or not PROGRAM.fullmatch(words[0]):
        return False
    name = interpreter_name(words[0])
    rest, k = words[1:], 0
    while k < len(rest):
        word = rest[k]
        if REDIRECTION.match(word):
            k += 2 if REDIRECTION.fullmatch(word) else 1  # a bare `>` names its target next
            continue
        if word == "-":
            return True
        if not word.startswith("-"):
            return False
        if gives_script(word, name):
            return rest[k + 1:k + 2] == ["-"]
        if name in SHELLS and re.fullmatch(r"-[a-z]*s[a-z]*", word):
            return True
        k += 1
    return True


def first_interpreter_reads(commands):
    """Whether the first interpreter among a pipeline's commands reads its script from standard
    input. Commands before it (`cat`, `sed`) pass the text on; once an interpreter has read it,
    later ones get only its output (`python3 gen.py <<EOF | sh`)."""
    for command in commands:
        words = program_words(command)
        if words and PROGRAM.fullmatch(words[0]):
            return reads_script(command)
    return False


def piped_to(rest_of_line):
    """The commands a PowerShell here-string is piped into: the pipeline after its closing line."""
    return re.split(r";|&&|\|\|", rest_of_line)[0].split("|")[1:]


def inline_script(text, shell):
    """Whether an interpreter is handed a script holding a backslash."""
    found = heredoc(text) if shell == "bash" else None
    if found and "\\" in found[1] and first_interpreter_reads(found[0]):
        return True
    if shell == "powershell" and any("\\" in (here.group(2) or "")
                                     and first_interpreter_reads(piped_to(here.group(3)))
                                     for here in here_strings(text)):
        return True
    # A `python -c '...'` a message only mentions leaves no call where its quotes are taken out.
    masked, end = masked_calls(text, shell)
    return any("\\" in (m.group(2) or m.group(4) or "") and m.start() < end and INLINE_CALL.match(masked, m.start())
               for m in INLINE.finditer(text))


def here_strings(text):
    """The PowerShell here-strings that stand outside quotes and comments, with the rest of the
    line each one ends on: the quote scan meets them before anything that would hold them."""
    return [HERE_STRING.match(text, m.start()) for m in quoted(text, "powershell") if m.group().startswith("@")]


def quoted(text, shell):
    """The quoted strings, comments and escapes the shell's scan finds, in order. A PowerShell
    here-string opener is tried only while a line that may close it follows."""
    if shell == "bash":
        return list(QUOTED["bash"].finditer(text))
    closes = {quote: text.rfind("\n" + quote + "@") for quote in "'\""}
    found, at = [], 0
    while True:
        start = POWERSHELL_QUOTE_START.search(text, at)
        if not start:
            return found
        quotes = "".join(quote for quote in "'\"" if closes[quote] > start.start())
        match = POWERSHELL_SCANS[quotes].match(text, start.start())
        if match:
            found.append(match)
        at = match.end() if match else start.start() + 1


def masked(text, shell, replace):
    """The command with each match of the shell's scan replaced by `replace`, a text or a
    function of the match, as `re.sub` takes it."""
    parts, at = [], 0
    for match in quoted(text, shell):
        parts += [text[at:match.start()], replace(match) if callable(replace) else replace]
        at = match.end()
    return "".join(parts + [text[at:]])


def masked_calls(text, shell):
    """(the command with quoted strings, comments and PowerShell here-strings masked to the same
    length, where a call may stand): a bash command only up to the end of the first line that may
    open a here-document, as in `bare`."""
    end = len(text)
    if shell == "bash":
        first = first_opener(text)
        if first:
            end = len("\n".join(text.split("\n")[:first[0] + 1]))
    return masked(text, shell, as_quote), end


def bare(text, shell):
    """The command with quoted strings taken out, and PowerShell here-string bodies; a bash
    command only up to the end of the first line that may open a here-document, quoted or not
    (`"$(cat <<'EOF'`), since reading too little only misses a pattern."""
    if shell == "bash":
        first = first_opener(text)
        if first:
            text = "\n".join(text.split("\n")[:first[0] + 1])
    return masked(text, shell, "''")


class Followed:
    """A search for `head`, then any characters but `stops`, then `rest`: the same answer as one
    pattern joining them, in time linear in the text. Every head whose run ends at the same stop
    finds `rest` only where the head ending first does, so `rest` is tried once per stop, where
    the joined pattern tries it once per head and a line repeating the head takes time that grows
    with its length squared. `skip_line` names text whose line a head may not start on."""

    def __init__(self, head, stops, rest, flags=re.I, skip_line=()):
        self.head = re.compile(head, flags)
        self.stop = re.compile("[%s]" % stops)
        self.tail = re.compile("[^%s]*%s" % (stops, rest), flags)
        self.skip_line = skip_line

    def skips(self, text, newlines, line):
        begin = newlines[line - 1] + 1 if line else 0
        end = newlines[line] if line < len(newlines) else len(text)
        return any(word in text[begin:end] for word in self.skip_line)

    def search(self, text):
        stops = [match.start() for match in self.stop.finditer(text)]
        newlines = [match.start() for match in re.finditer("\n", text)] if self.skip_line else []
        skipped, tried = {}, set()
        for head in self.head.finditer(text):
            run_end = bisect.bisect_left(stops, head.end())
            if run_end in tried:
                continue
            if self.skip_line:
                line = bisect.bisect_left(newlines, head.start())
                if line not in skipped:
                    skipped[line] = self.skips(text, newlines, line)
                if skipped[line]:
                    continue
            tried.add(run_end)
            if self.tail.match(text, head.end()):
                return True
        return False


def both(*patterns):
    """A test that holds when every pattern (a regex, or a `Followed`) is found in the bare command."""
    compiled = [p if isinstance(p, Followed) else re.compile(p, re.I) for p in patterns]
    return lambda text, shell: all(p.search(bare(text, shell)) for p in compiled)


def cased(pattern):
    """Like `both`, for one test whose letter case carries meaning (`-b` is not `-B`)."""
    compiled = pattern if isinstance(pattern, Followed) else re.compile(pattern)
    return lambda text, shell: bool(compiled.search(bare(text, shell)))


# Where the hook runs: the session's folder, from the hook's input; "." until it says.
CWD = "."
def merge_style():
    """How the repo the hook runs in merges its PRs, by the answers Bindwright's setup saved, or None."""
    try:
        folder = os.path.abspath(CWD)
    except OSError:  # a "." whose folder was deleted
        return None
    while True:
        try:
            with open(os.path.join(folder, ".bindwright", "project.json"), encoding="utf-8") as answers:
                style = json.load(answers).get("advanced", {}).get("mergeStyle")
            return style if isinstance(style, str) else None
        # RecursionError: JSON nested deeper than the reader goes.
        except (OSError, ValueError, AttributeError, RecursionError):
            pass
        parent = os.path.dirname(folder)
        if parent == folder or os.path.exists(os.path.join(folder, ".git")):
            return None
        folder = parent


def squash_merges():
    return merge_style() == "squash"


# What may follow a flag the rows below count: a space, an operator that ends its command, a closing
# parenthesis or the input's end. Anything else, a value written onto it (`--failed=false`) included, is
# left unread.
FLAG_END = r"(?=[\s|;&)]|$)"

MERGE_STYLES = ("merge", "squash", "rebase")
# The flags that rewrite a PR's commits. `--merge` is left out: gitflow merges release and cascade PRs
# with it whatever the work PRs use, and a merge commit keeps every branch's history.
MERGE_FLAGS = {style: Followed(r"\bgh\s+pr\s+merge\b", r"\n|;&", r"\s(?:--%s|-%s)" % (style, style[0]) + FLAG_END,
                               flags=0)
               for style in ("squash", "rebase")}


def other_merge_style(text, shell):
    """Whether a `gh pr merge` asks for a merge style other than the one the repo saved."""
    command = bare(text, shell)
    asked = {style for style, flag in MERGE_FLAGS.items() if flag.search(command)}
    if not asked:
        return False
    saved = merge_style()
    return saved in MERGE_STYLES and bool(asked - {saved})


GIT_COMMIT = both(r"\bgit\s+commit\b")
# A changelog heading that carries a date: a released section, which a later release never edits.
DATED_HEADING = re.compile(r"^## .*\b\d{4}-\d{2}-\d{2}\b")
# A link reference line (`[1.0.0]: https://...`), which Keep a Changelog keeps at the file's end: a release
# cut edits these, so they belong to no section.
LINK_REFERENCE = re.compile(r"^\[[^\]]+\]:\s")
# Seconds the changelog row's git calls share, well inside the hook's 10 s limit in a project.
GIT_SECONDS = 4
# The largest changelog the row reads, in bytes, either copy: a long-lived project's runs to a few hundred KB.
CHANGELOG_LIMIT = 4 * 1024 * 1024


def repo_root():
    """The folder holding CWD's `.git` (a folder, or a worktree's file), or None outside a repo."""
    try:
        folder = os.path.abspath(CWD)
    except OSError:  # a "." whose folder was deleted
        return None
    while not os.path.exists(os.path.join(folder, ".git")):
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent
    return folder


def real_path(path):
    return os.path.normcase(os.path.realpath(path))


def resolved(entry):
    """`entry` resolved, or None when it cannot be, as Windows reports for a share that refuses the
    sign-in; such a folder is never searched."""
    try:
        return real_path(entry)
    except OSError:
        return None


def is_within(folder, top):
    """Whether `folder` is `top` or below it; two paths on different drives never are."""
    try:
        return os.path.commonpath([folder, top]) == top
    except ValueError:
        return False


def repo_folder(start):
    """The top folder of the outermost repo holding `start`, where a repo, or the one a
    submodule sits in, could ship its own programs. A repo at the home folder or above it holds
    the user's own installs and does not count, unless the home folder is unknown. Outside a
    repo it is `start` itself, or None when `start` is the home folder or above it."""
    home = os.path.expanduser("~")
    home = real_path(home) if os.path.isabs(home) else None
    folder = real_path(start)
    top = None if home and is_within(home, folder) else folder
    while True:
        if os.path.exists(os.path.join(folder, ".git")) and not (home and is_within(home, folder)):
            top = folder
        parent = os.path.dirname(folder)
        if parent == folder:
            return top
        folder = parent


def trusted_folders(root):
    """The PATH folders a repo cannot have shipped a program in, or None when the hook's own folder is gone.
    A PATH folder that is relative (a `.`), is the session folder or the current folder, or sits in the
    folder repo_folder gives for `root` is skipped; Windows's search of the current folder first is switched
    off."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        here = {real_path(place) for place in (CWD, os.getcwd())}
    except OSError:  # the hook's own folder was deleted
        return None
    repo = repo_folder(root)
    folders = {entry: resolved(entry) for entry in os.environ.get("PATH", "").split(os.pathsep)
               if os.path.isabs(entry)}
    return [entry for entry, real in folders.items()
            if real and real not in here and not (repo and is_within(real, repo))]


def trusted_program(root, name):
    """The program `name` (git, gh) as an absolute path from the trusted folders, so a repo's own copy never
    runs, or None when none of them holds one."""
    folders = trusted_folders(root)
    found = folders and shutil.which(name, path=os.pathsep.join(folders))
    return found if found and os.path.isabs(found) else None


def git_output(git, root, deadline, *args):
    """What a git command run in the repo prints, or None when it fails or the monotonic `deadline` passes."""
    left = deadline - time.monotonic()
    if left <= 0:
        return None
    # Nothing to wait on: no input, no credential prompt, no fetch of a missing object.
    quiet = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1")
    try:
        process = subprocess.Popen([git, "-C", root, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=quiet)
    except OSError:
        return None
    try:
        out, _ = process.communicate(timeout=left)
    except subprocess.TimeoutExpired:
        # Waiting again for the output, as `subprocess.run` does, can outlast the deadline: on Windows a
        # launcher's child keeps the pipe open after the launcher is killed.
        process.kill()
        return None
    return out.decode("utf-8", "replace") if process.returncode == 0 else None


def stored_text(git, root, deadline, spec):
    """The blob git stores at `spec` (`HEAD:CHANGELOG.md`, `:CHANGELOG.md` for the staged copy), or None when
    there is none, it passes CHANGELOG_LIMIT or git cannot read it. A link is stored as its target's name,
    so nothing outside git's own data is ever opened."""
    size = git_output(git, root, deadline, "cat-file", "-s", spec)
    if size is None or not size.strip().isdigit() or int(size) > CHANGELOG_LIMIT:
        return None
    return git_output(git, root, deadline, "cat-file", "blob", spec)


def dated_sections(changelog):
    """Each dated section's text by its heading line, without link lines or trailing blank lines."""
    sections, heading = {}, None
    for line in changelog.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("## "):
            heading = line if DATED_HEADING.match(line) else None
            if heading is not None:
                sections[heading] = []
        elif heading is not None and not LINK_REFERENCE.match(line):
            sections[heading].append(line)
    return {heading: "\n".join(lines).rstrip() for heading, lines in sections.items()}


def edits_dated_changelog(text, shell):
    """Whether a `git commit` runs while a dated section of the last commit's CHANGELOG.md is changed or gone
    in the staged copy. Only what git stores is read, never the file on disk, which the repo controls, so a
    change staged in the same command as the commit (`git add`, `git commit -a`) is not seen."""
    if not GIT_COMMIT(text, shell):
        return False
    root = repo_root()
    git = root and trusted_program(root, "git")
    if not git:
        return False
    deadline = time.monotonic() + GIT_SECONDS
    old = stored_text(git, root, deadline, "HEAD:CHANGELOG.md")
    new = old and stored_text(git, root, deadline, ":CHANGELOG.md")
    if new is None or not old:
        return False
    current = dated_sections(new)
    return any(current.get(heading) != section for heading, section in dated_sections(old).items())


# `origin/develop:.claude/x`: a git object path that starts with a dot.
REV_DOT_PATH = Followed(r"\bgit\s+(?:show|cat-file|ls-tree|diff)\b", r"\n|;&", r"\s[\w./@~^-]+:\.[^/\s.]")

ENFORCE = "enforce"
OBSERVE = "observe"
OBSERVED_LOG = os.path.join(os.path.expanduser("~"), ".bindwright", "tool-rules", "observed.jsonl")
# Past this many bytes the log moves to a single `.old` copy and starts over, so it never grows unbounded.
OBSERVED_LOG_LIMIT = 256 * 1024
# A run of 24 or more letters, digits and _-+/= holding a digit reads as a token or key (base64 included):
# the log keeps a placeholder. The digit is checked on each run found, since a lookahead for it
# makes a long run take time that grows with its length squared.
TOKEN_RUN = re.compile(r"[A-Za-z0-9_\-+/=]{24,}")


def without_tokens(text):
    return TOKEN_RUN.sub(lambda run: "<token>" if re.search(r"\d", run.group()) else run.group(), text)

RULES = [
    ("an inline script holding a backslash", inline_script, WRITE_THE_FILE, ENFORCE),
    ("`gh run watch`", both(r"\bgh\s+run\s+watch\b"),
     "it blocks the session. ci-watch (or a bounded watcher, token-efficiency.md) watches checks.", ENFORCE),
    ("the size check chained with a commit or push",
     both(r"(?:^|(?<=[\s;&|(]))(?:python3?|py)(?:\.exe)?\s+(?:-\S+\s+)*\S*size_check\.py",
          r"\bgit\s+(?:commit|push)\b"),
     "the commit runs past its breaches. Run size_check.py in its own call first.", ENFORCE),
    ("`git push` and `gh pr create` in one command", both(r"\bgit\s+push\b", r"\bgh\s+pr\s+create\b"),
     "the chain gets refused. Push, then open the PR in a separate call.", ENFORCE),
    ("`git checkout <rev> -- <path>`", both(r"\bgit\s+checkout\s+(?!-)\S+\s+--\s+\S"),
     "it overwrites and stages those files. Peek with `git show <rev>:./<path>`; restore with `git restore`.",
     ENFORCE),
    ("`gh pr merge --admin`", both(Followed(r"\bgh\s+pr\s+merge\b", r"\n", r"\s--admin\b")),
     "it skips the required checks. Fix what blocks the merge.", ENFORCE),
    ("a repo secret write (`gh secret set` or `delete`)",
     both(r"\bgh\s+secret\s+(?:set|delete|remove)\b"),
     "secrets are the maintainer's, and a test run can overwrite the real ones. Give the user the command.",
     ENFORCE),
    ("`<rev>:.<path>` in Git Bash",
     lambda text, shell: GIT_BASH and shell == "bash" and REV_DOT_PATH.search(bare(text, shell)),
     "Git Bash rewrites it, so the file looks missing. Write `<rev>:./<path>` from the repo root.", ENFORCE),
    ("`gh run rerun --failed` or `--job`",
     both(Followed(r"\bgh\s+run\s+rerun\b", r"\n|;&", r"\s(?:--failed|--job|-j)" + FLAG_END)),
     "a re-run of only some jobs can leave a required check stuck. Re-run the whole run, or push again.", OBSERVE),
    ("an interactive git command (`-i`, `-p`)",
     # `git stash show -p` only prints, and a rebase given a scripted editor never waits for keys.
     cased(Followed(r"\bgit\s+(?:rebase|add|checkout|reset|stash(?!\s+(?:show|list)\b)|restore|clean)\b",
                    r"\n|;&", r"\s(?:-i|--interactive|-p|--patch)\b", flags=0,
                    skip_line=("GIT_SEQUENCE_EDITOR=", "sequence.editor="))),
     "it waits for an editor or keys a tool call cannot give. Use the form that takes its input in the command.",
     OBSERVE),
    ("an inline body for `gh pr` or `gh issue`",
     cased(Followed(r"\bgh\s+(?:pr|issue)\s+(?:create|comment|edit|review)\b", r"\n|;&",
                    r"\s(?:--body|-b)(?:[=\s]|$)", flags=0)),
     "the shell can cut or change the text. Write the body to a file and pass `--body-file`.", OBSERVE),
    ("a scratch file in a fixed folder (`/tmp`, `C:/tmp`)",
     # Claude Code's own session scratchpad lives under /tmp/claude-<id>/ on Linux.
     both(r"(?:^|(?<=[\s=>]))(?:/tmp|[a-z]:[\\/]tmp)(?![\w.-]|/claude-\d+/)"),
     "other sessions share it, and nothing cleans it up. Use the session's scratchpad instead.", OBSERVE),
    ("`jq` in Git Bash", lambda text, shell: GIT_BASH and shell == "bash" and JQ.search(bare(text, shell)),
     "Git Bash has no `jq`. Filter with the `--jq` option of `gh`, or with Python.", OBSERVE),
    # `git checkout -- <file>` restores files and switches nothing.
    ("a branch switch chained with other commands",
     both(r"\bgit\s+(?:checkout|switch)\b(?!\s+--(?:\s|$))", r"&&|\|\||;|\n[^\S\n]*\S"),
     "a refused or failed chain can skip the switch, so the next edit lands on the wrong branch. Switch in a"
     " call of its own, check `git branch --show-current`, then go on.", OBSERVE),
    ("a `gh pr merge` style other than the repo's", other_merge_style,
     "the repo saved another merge style at setup (`mergeStyle` in `.bindwright/project.json`), and mixing"
     " them breaks the history it reads. Merge with the flag `git.md` names.", OBSERVE),
    ("a commit that edits a released CHANGELOG.md section", edits_dated_changelog,
     "a dated section records what that release shipped, so it never changes. Put the change under"
     " `[Unreleased]` instead.", OBSERVE),
]


# The commit format's subject limit, and the PR title limit where PRs squash-merge: GitHub adds ` (#123)`
# to the title it makes the commit subject.
SUBJECT_LIMIT = 72
TITLE_LIMIT = 64
MENTIONS_COMMIT = Followed(r"\bgit\b", r"\n;&|", r"\bcommit\b", flags=0)
MENTIONS_PR = re.compile(r"\bgh\s+pr\s+(?:create|edit)\b")
LANDED_SECONDS = 10
# A commit or PR counts as this command's only when it was written this recently: a command that only
# mentions a commit or a PR (a log search, a dry run, a commit that failed) leaves an older one in place.
FRESH_SECONDS = 120


def landed(program, *args):
    """The first line `program` prints in the session's repo, or None outside one, when it fails or when
    LANDED_SECONDS pass."""
    root = repo_root()
    folders = root and trusted_folders(root)
    found = folders and shutil.which(program, path=os.pathsep.join(folders))
    if not found or not os.path.isabs(found):
        return None
    command = [found, "-C", root, *args] if program == "git" else [found, *args]
    # gh starts git itself, so its PATH holds only the trusted folders.
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", PATH=os.pathsep.join(folders))
    try:
        process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=env)
    except OSError:
        return None
    try:
        out, _ = process.communicate(timeout=LANDED_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()  # no second wait, as in git_output
        return None
    out = out.decode("utf-8", "replace") if process.returncode == 0 else ""
    return out.split("\n", 1)[0].strip() or None


def is_fresh(seconds_since_epoch):
    """Written within FRESH_SECONDS of now either way, since GitHub's clock and this computer's can differ."""
    return abs(time.time() - seconds_since_epoch) <= FRESH_SECONDS


def fresh_subject():
    """The subject of the commit at HEAD when it was written in the last FRESH_SECONDS and is not a merge,
    whose subject git writes."""
    line = landed("git", "log", "-1", "--format=%ct %P%x09%s")
    stamp, _, subject = (line or "").partition("\t")
    when, *parents = stamp.split(" ")
    return subject if when.isdigit() and len(parents) <= 1 and is_fresh(int(when)) else None


def fresh_title():
    """The title of the current branch's PR when it changed in the last FRESH_SECONDS."""
    line = landed("gh", "pr", "view", "--json", "title,updatedAt", "-q", '.updatedAt + "\\t" + .title')
    stamp, _, title = (line or "").partition("\t")
    try:
        when = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return title if is_fresh(when.timestamp()) else None


def length_notes(text):
    """A note for each commit subject or PR title the command wrote over its limit."""
    notes = []
    subject = fresh_subject() if MENTIONS_COMMIT.search(text) else None
    if subject and len(subject) > SUBJECT_LIMIT:
        notes.append(f"The commit subject that landed is {len(subject)} characters, over the {SUBJECT_LIMIT} the"
                     " commit format allows. Shorten it with `git commit --amend` before pushing.")
    if MENTIONS_PR.search(text) and squash_merges():
        title = fresh_title()
        if title and len(title) > TITLE_LIMIT:
            notes.append(f"The PR title is {len(title)} characters, over {TITLE_LIMIT}: it becomes the commit"
                         " subject when the PR squash-merges. Shorten it with `gh pr edit --title`.")
    return notes


def observe(name, text, shell):
    """Append one would-be refusal to OBSERVED_LOG; a log that cannot be written is skipped."""
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "rule": name, "shell": shell,
             "command": without_tokens(text)[:500]}
    try:
        os.makedirs(os.path.dirname(OBSERVED_LOG), exist_ok=True)
        if os.path.exists(OBSERVED_LOG) and os.path.getsize(OBSERVED_LOG) > OBSERVED_LOG_LIMIT:
            os.replace(OBSERVED_LOG, OBSERVED_LOG + ".old")
        with open(OBSERVED_LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def refusal(text, shell):
    """The first enforce rule the command breaks, as (name, why), or None.

    Observe rules it breaks before that one are logged."""
    for name, test, why, mode in RULES:
        if not test(text, shell):
            continue
        if mode == ENFORCE:
            return name, why
        observe(name, text, shell)
    return None


def deny(name, why):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": f"BLOCKED (tool rule): {name}: {why}",
    }}))
    sys.exit(0)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        text = data["tool_input"]["command"]
    except Exception:
        sys.exit(0)
    if not isinstance(text, str):
        sys.exit(0)
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    global CWD
    cwd = data.get("cwd")
    CWD = cwd if isinstance(cwd, str) and cwd else CWD
    if data.get("hook_event_name") == "PostToolUse":
        notes = [] if data.get("agent_id") else length_notes(text)
        if notes:
            sys.stdout.write(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PostToolUse", "additionalContext": " ".join(notes)}}))
        sys.exit(0)
    refused = refusal(text, shell)
    if refused:
        deny(*refused)
    sys.exit(0)


if __name__ == "__main__":
    main()
