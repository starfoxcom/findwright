"""Count this session's code-research calls: FindWright versus plain text search.

Reads the newest transcript for the current directory under
~/.claude/projects/, or the transcript given as the first argument.
Run from the repo root at session close.

A plain search counts only when it looks for code inside the repo: a Grep
or Glob call, or a shell command that starts with a recursive search (grep
-r, rg, git grep, or a recursive listing piped into Select-String). Each
search is judged by what it reads: its file filters (globs, types,
-Include) when it has any, otherwise the files and folders it names, and a
folder by the files git tracks in it. A search that reads only docs, logs
or data files, a filter on another command's output (`... | grep x`), and
a search of folders outside the repo (a scratchpad, a package cache),
which the code-research tool has no index for, are not counted. When the
words cannot be read for sure, the search counts unless it runs outside
the repo and names nothing inside it, the side that never flatters the
figure.
"""
import glob
import json
import os
import re
import shlex
import subprocess
import sys

TOOL = re.compile(r"findwright")
BYPASS = "FINDWRIGHT_BYPASS:"
NON_CODE_EXTENSIONS = {"md", "mdx", "txt", "log", "json", "jsonl", "yaml", "yml", "csv"}
# ripgrep's and grep's file types for the same files.
NON_CODE_TYPES = {"md", "markdown", "txt", "json", "jsonl", "yaml", "csv", "log"}
SHELL_SEARCH = re.compile(r"^\s*(rg|ag|ack|git\s+grep)\s|^\s*grep\s(.*\s)?(-[a-zA-Z]*[rR]|--recursive)")
PS_LISTING = re.compile(r"^\s*(Get-ChildItem|gci|dir|ls)\s.*-Recurse", re.I)
PS_SEARCH = re.compile(r"^\s*(sls|Select-String)\s", re.I)
# Git Bash spells a Windows drive as /p/...; Python reads it as P:/...
GIT_BASH_DRIVE = re.compile(r"^/([a-zA-Z])/")
CD = re.compile(r"^\s*(cd|Set-Location|sl|pushd|popd)(?:\s+(.+?))?\s*$", re.I)
# Moves whose target the line cannot show: back (cd -, popd) or home (a bare cd).
RETURN_TARGETS = (None, "-")
REDIRECT = re.compile(r"^(?:\d*|&)[<>]")
# A redirect operator written apart from its target (`2> /dev/null`): the next word is the target.
BARE_REDIRECT = re.compile(r"^(?:\d*|&)(?:>>?|<)&?$")
WILDCARD = re.compile(r"[*?\[]")

# Options whose value narrows the files a search reads, written apart (`-g x`) or joined (`-gx`,
# `--glob=x`, `-Include:x`). Every other word only matters when it names a file or folder that exists.
FILTER_OPTIONS = ("-g", "--glob", "--iglob", "--include", "-t", "--type", "-include", "-filter",
                  "--exclude", "--exclude-dir", "-exclude")
# Their values leave files out; they never say what the search reads.
EXCLUDE_OPTIONS = ("--exclude", "--exclude-dir", "-exclude")
TYPE_OPTIONS = ("-t", "--type")
# With none of these, a text search takes its pattern as a plain word.
PATTERN_OPTIONS = ("-e", "--regexp", "-f", "--file", "--files")
PATTERN_VALUE_OPTIONS = ("-e", "--regexp", "-f", "--file")
# Short flags that take no value in rg, grep, git grep, ag and ack alike, and more per tool. A word
# after any other option may be its value, so it never decides what a search reads.
FLAGS_WITHOUT_VALUE = "cFHhilLnosvw"
TOOL_FLAGS_WITHOUT_VALUE = {"grep": "EIPqRrx", "rg": "IPqSUuxz", "ag": "f"}
# Only these take a pattern file after `-f`: in ag it follows links, in ack it lists files.
PATTERN_FILE_TOOLS = ("grep", "rg")


def unquote_separators(command):
    """Blank out | ; & and newlines inside quotes, so a search pattern like "a|b" does not split the command."""
    out, quote = [], None
    for ch in command:
        if quote:
            quote = None if ch == quote else quote
            ch = " " if ch in "|;&\n" else ch
        elif ch in "'\"":
            quote = ch
        out.append(ch)
    return "".join(out)


def unquote(word):
    return word.strip("'\"")


def resolve(path, base):
    """The absolute, case-folded form of a path as a shell in `base` reads it."""
    path = os.path.expanduser(unquote(path))
    if os.name == "nt":
        path = GIT_BASH_DRIVE.sub(lambda m: m.group(1) + ":/", path)
    return os.path.normcase(os.path.abspath(os.path.join(base, path)))


def is_outside(path, root):
    """True when `path` is neither the repo root nor anything under it."""
    try:
        return os.path.commonpath([path, root]) != root
    except ValueError:
        return True  # another drive


def is_wide(name):
    """True when a glob names no extension, so it narrows nothing by file kind (`*`, `docs/**`)."""
    return "." not in os.path.basename(unquote(name).rstrip("/\\"))


def is_code_name(name):
    """True when a file name or glob can match a code file, one whose extension is not a doc's."""
    name = unquote(name).rstrip("/\\")
    braces = re.search(r"\{([^}]*)\}$", name)
    endings = [name]
    if braces:
        endings = [name[:braces.start()] + part for part in braces.group(1).split(",")]
    for ending in endings:
        extension = ending.rsplit(".", 1)[-1].lower() if "." in os.path.basename(ending) else ""
        if extension not in NON_CODE_EXTENSIONS:
            return True
    return False


def tracked_files(root):
    """The tracked files, absolute and case-folded; every file there when git cannot list them."""
    try:
        command = ["git", "-C", root, "ls-files", "-z"]
        listed = subprocess.run(command, capture_output=True, check=True).stdout
        names = [n for n in listed.decode("utf-8", "replace").split("\0") if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
        for folder, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d != ".git"]
            names += [os.path.relpath(os.path.join(folder, f), root) for f in files]
    return [os.path.normcase(os.path.abspath(os.path.join(root, n))) for n in names]


class Repo:
    """The repo a search is judged against: its root and, read once when needed, its code files."""

    def __init__(self, root):
        self.root = root
        self._code_files = None

    def code_files(self):
        if self._code_files is None:
            self._code_files = [f for f in tracked_files(self.root) if is_code_name(f)]
        return self._code_files

    def holds_code(self, path):
        """True when an in-repo file or folder is code, or cannot be told apart from code."""
        if WILDCARD.search(os.path.basename(path)):
            return is_code_name(path)
        if os.path.isdir(path):
            # Case-blind: macOS and Windows folders match whatever case the search typed.
            prefix = path.rstrip("\\/").lower() + os.sep
            return path == self.root or any(f.lower().startswith(prefix) for f in self.code_files())
        return is_code_name(path)


class Search:
    """What one search reads: the paths it names, and the globs and types that narrow its files."""

    def __init__(self, paths=(), globs=(), types=(), is_sure=True):
        self.paths = list(paths)
        # False when the words cannot be told apart: then only where the search runs and what
        # its words point at are judged.
        self.is_sure = is_sure
        # A negated glob (`!*.md`) leaves files out; it never says what the search reads.
        globs = [g for g in map(unquote, globs) if g]
        self.globs = [g for g in globs if not g.startswith("!") and not is_wide(g)]
        self.types = [unquote(t).lower() for t in types]

    def reads_code(self, base, repo):
        """True when the search reads code inside the repo, with paths read from `base`."""
        named = [resolve(p, base) for p in self.paths]
        if not self.is_sure:
            # Counted unless it runs outside the repo and no word it names lies inside it.
            return not is_outside(base, repo.root) or any(
                not is_outside(p, repo.root) for p, word in zip(named, self.paths)
                if os.path.exists(p) or re.search(r"[/\\]", word))
        # A word with a folder in it is a named path even once it is gone (a deleted temp clone).
        paths = [p for p, word in zip(named, self.paths)
                 if os.path.exists(p) or WILDCARD.search(os.path.basename(p))
                 or re.search(r"[/\\]", word)] or [base]
        inside = [p for p in paths if not is_outside(p, repo.root)]
        if not inside:
            return False
        if self.globs or self.types:
            return (any(is_code_name(g) for g in self.globs)
                    or any(t not in NON_CODE_TYPES for t in self.types))
        return any(repo.holds_code(p) for p in inside)


def split_words(head):
    """The words of one command, with quotes kept; redirects, their targets and a trailing
    comment (a bypass marker) dropped."""
    # Not POSIX mode, which reads a backslash as an escape and would turn D:\scratch into
    # D:scratch; quotes stay on the words, and resolve() strips them.
    try:
        words = shlex.split(head, posix=False)
    except ValueError:
        words = head.split()
    kept, skip_next = [], False
    for word in words:
        if word.startswith("#"):
            break
        if skip_next:
            skip_next = False
        elif BARE_REDIRECT.match(word):
            skip_next = True
        elif not REDIRECT.match(word):
            kept.append(word)
    return kept


def filter_of(word, words, tool):
    """(option, value) when `word` is a filter option, taking a separate value from `words`."""
    for option in FILTER_OPTIONS:
        if len(option) == 2 and tool != "rg":
            continue  # `-g` and `-t` filter files only in ripgrep (`ag -t` searches all text)
        # Short options keep their case (`-T` excludes a type); long and PowerShell ones do not.
        spelled = word if len(option) == 2 else word.lower()
        if spelled == option:
            return option, words.pop(0) if words else ""
        if spelled.startswith(option) and spelled[len(option):len(option) + 1] in ("=", ":"):
            return option, word[len(option) + 1:]
        if len(option) == 2 and spelled.startswith(option):
            return option, word[2:]
    return None


def takes_no_value(word, tool):
    """True when `word` is a cluster of short flags that take no value in `tool`."""
    flags = FLAGS_WITHOUT_VALUE + TOOL_FLAGS_WITHOUT_VALUE.get(tool, "")
    return bool(re.fullmatch(r"-[A-Za-z]+", word)) and all(letter in flags for letter in word[1:])


def filter_values(value, rest):
    """The values of one filter option; a PowerShell list (`"*.md","*.py"`, `*.md, *.py`) arrives
    as several words, taken from `rest`."""
    while rest and (value.endswith(",") or rest[0].startswith(",")):
        value += rest.pop(0)
    # A comma inside braces belongs to the glob (`*.{md,txt}`), not the list.
    return [v for v in (unquote(v.strip()) for v in re.split(r",(?![^{}]*\})", value)) if v]


def read_words(rest, tool):
    """(plain, globs, types, pattern_given, has_unknown) for a command's words after its name.
    The plain words include an option's `=` or `:` value. has_unknown is True when an option is
    none the script knows: a filter, a pattern option, `--`, or a cluster of short flags that take
    no value in `tool`."""
    plain, globs, types = [], [], []
    pattern_given = has_unknown = False
    while rest:
        word = rest.pop(0)
        if word == "--":  # the end of the options: every word after it is plain
            plain += rest
            break
        found = filter_of(word, rest, tool) if word.startswith("-") else None
        if found:
            option, value = found
            values = filter_values(value, rest)  # an exclude list is read whole, then left out
            if option not in EXCLUDE_OPTIONS:
                (types if option in TYPE_OPTIONS else globs).extend(values)
        elif (word in PATTERN_OPTIONS or word.split("=", 1)[0] in PATTERN_VALUE_OPTIONS) and (
                word != "-f" or tool in PATTERN_FILE_TOOLS):
            pattern_given = True
            if word in PATTERN_VALUE_OPTIONS and rest:
                rest.pop(0)  # the pattern, or the file that holds it
        elif word.startswith("-"):
            joined = re.split(r"[=:]", word, maxsplit=1)
            if len(joined) == 2:
                plain.append(joined[1])
            has_unknown = has_unknown or len(joined) == 2 or not takes_no_value(word, tool)
        else:
            plain.append(word)
    return plain, globs, types, pattern_given, has_unknown


def words_search(words, is_text_search=True):
    """What a text search or a recursive listing reads: its filters, and every word that may name a path.

    A text search is read for sure only when every option in it is one `read_words` knows; then it
    takes its first plain word as its pattern unless `-e`, `-f` or `--files` gives one, and
    `Search.reads_code` keeps only the words that name a file or folder that exists. With any other
    option the words cannot be read for sure, and only where the search runs and what its words
    point at are judged."""
    if words[:2] == ["git", "grep"]:
        words = words[1:]
    tool = words[0] if words else ""
    # An option's joined value is cut from it; any other word stays whole (`D:\proj\src`).
    unsure = Search([unquote(re.split(r"[=:]", w, maxsplit=1)[-1] if w.startswith("-") else w)
                     for w in words[1:]], is_sure=False)
    if any(word.count('"') % 2 or word.count("'") % 2 for word in words):
        return unsure  # a quote the word does not close: `--regexp="see docs"` split at the space
    plain, globs, types, pattern_given, has_unknown = read_words(words[1:], tool)
    if is_text_search:
        if has_unknown:
            return unsure  # an option it does not know may take a value or give the pattern
        named = plain[0 if pattern_given else 1:]
    else:
        # A PowerShell listing's comma list is several paths.
        named = [piece for word in plain for piece in word.split(",") if piece]
    paths = []
    for piece in named:
        # An unquoted `*.md` with no folder is a file filter; a quoted one is a pattern.
        is_filter = WILDCARD.search(piece) and not re.search(r"['\"/\\]", piece)
        (globs if is_filter else paths).append(unquote(piece))
    return Search(paths, globs, types)


def shell_search(command, repo):
    """True when a command line runs a code search of its own inside the repo."""
    base = repo.root
    for part in re.split(r"&&|\|\||;|\n", unquote_separators(command)):
        stages = part.split("|")
        head = stages[0]
        moved = CD.match(head)
        if moved:
            # The repo root is the folder such a move most likely returns to, and reading it so
            # keeps the search counted, the side that never flatters the figure.
            words = split_words(moved.group(2) or "")
            target = words[0] if words else None
            back = moved.group(1).lower() == "popd" or target in RETURN_TARGETS
            base = repo.root if back else resolve(" ".join(words), base)
            continue
        if SHELL_SEARCH.search(head):
            search = words_search(split_words(head))
        elif PS_LISTING.search(head) and any(PS_SEARCH.search(s) for s in stages[1:]):
            search = words_search(split_words(head), is_text_search=False)
        else:
            continue
        if search.reads_code(base, repo):
            return True
    return False


def tool_search(name, args):
    """What a Grep or Glob call reads."""
    path = str(args.get("path") or "")
    if name == "Grep":
        types = [str(args["type"])] if args.get("type") else []
        return Search([path] if path else [], [str(args.get("glob") or "")], types)
    pattern = str(args.get("pattern") or "")
    # A pattern can carry its own folder: an absolute one, or a relative one under the path.
    static = re.split(r"[*?\[{]", pattern, maxsplit=1)[0]
    folder = os.path.dirname(static) if os.path.dirname(static) else ""
    paths = [os.path.join(path, folder)] if folder else [path] if path else []
    return Search(paths, [pattern])


def classify(name, args, root=None):
    """'research', 'fallback', 'bypass', or None for a call that is not a code search.

    `root` is the repo root as `repo_root()` gives it; by default, the folder this runs from."""
    repo = root if isinstance(root, Repo) else Repo(root or repo_root())
    if TOOL.search(name):
        return "research"
    if name in ("Grep", "Glob"):
        return "fallback" if tool_search(name, args).reads_code(repo.root, repo) else None
    if name in ("Bash", "PowerShell"):
        command = args.get("command", "")
        if shell_search(command, repo):
            return "bypass" if BYPASS in command else "fallback"
    return None


def transcript():
    if len(sys.argv) > 1:
        return sys.argv[1]
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
    files = glob.glob(os.path.join(os.path.expanduser("~"), ".claude", "projects", slug, "*.jsonl"))
    if not files:
        sys.exit(f"No transcript found for {os.getcwd()}; run this from the repo root.")
    return max(files, key=os.path.getmtime)


def tool_calls(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            content = (entry.get("message") or {}).get("content")
            if entry.get("type") != "assistant" or not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    yield part.get("name", ""), part.get("input") or {}


def repo_root():
    """The folder this runs from, the repo root, in the form `classify` compares."""
    return os.path.normcase(os.path.abspath(os.getcwd()))


def main():
    counts = {"research": 0, "fallback": 0, "bypass": 0}
    repo = Repo(repo_root())
    for name, args in tool_calls(transcript()):
        kind = classify(name, args, repo)
        if kind:
            counts[kind] += 1
    total = counts["research"] + counts["fallback"]
    ratio = f"{100 * counts['research'] // total}%" if total else "n/a"
    print(f"FindWright: {counts['research']} calls, plain code searches: {counts['fallback']} "
          f"(plus {counts['bypass']} marked bypasses) -> {ratio}")


if __name__ == "__main__":
    main()
