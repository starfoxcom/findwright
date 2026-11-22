"""The attribution guard's file reading: the message and body files a command names,
and every folder each command may run in."""
import os
import re
from .shell import TEXT_TOOLS, program, shape_of, text_of


# With the parser: every command's file flags are read, except a text tool's, git's
# in a read (where -F or --file means something else) and gh's `--template` (a template
# name). Any other git subcommand, an alias included, is read as a write. A wrapper (`env`,
# `sudo`, `xargs`) or any other program has its flags read.
GIT_READS = {"grep", "log", "show", "whatchanged", "rev-list", "shortlog", "reflog", "diff", "blame",
             "status", "config", "clone", "init", "ls-files", "for-each-ref", "cat-file", "check-ignore"}
GIT_FILE_FLAGS = {"-F", "--file", "--template"}
GIT_WORD = re.compile(r"\bgit\b", re.I)  # `$GIT`, `$(command -v git)`
# Drive P's `x`: `/p/x` in Git Bash, `/mnt/p/x` in WSL.
GIT_BASH_DRIVE = re.compile(r"(?:/mnt)?/([A-Za-z])(?=/|$)")
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
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
# git's own options that take no next word (git(1)), `--exec-path` only an optional `=<path>`;
# git matches them whole, never abbreviated.
GIT_GLOBAL_FLAGS = {"-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects",
                    "--no-lazy-fetch", "--no-optional-locks", "--no-advice", "--literal-pathspecs",
                    "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--exec-path",
                    "--html-path", "--man-path", "--info-path"}
HOME_COMMANDS = {"cd", "chdir", "set-location", "sl"}  # alone, each goes home
CD_COMMANDS = HOME_COMMANDS | {"pushd", "popd", "push-location", "pop-location"}
MAX_PLACES = 64  # folders one command may run in before the guard stops placing them
# PowerShell's approved verbs (Get-Verb): a cmdlet is named <verb>-<noun>; program() gives names lowercase.
CMDLET = re.compile(r"([a-z]+)-[a-z]+")
CMDLET_VERBS = {"add", "approve", "assert", "backup", "block", "build", "checkpoint", "clear", "close",
                "compare", "complete", "compress", "confirm", "connect", "convert", "convertfrom",
                "convertto", "copy", "debug", "deny", "deploy", "disable", "disconnect", "dismount",
                "edit", "enable", "enter", "exit", "expand", "export", "find", "format", "get",
                "grant", "group", "hide", "import", "initialize", "install", "invoke", "join", "limit",
                "lock", "measure", "merge", "mount", "move", "new", "open", "optimize", "out", "ping",
                "pop", "protect", "publish", "push", "read", "receive", "redo", "register", "remove",
                "rename", "repair", "request", "reset", "resize", "resolve", "restart", "restore",
                "resume", "revoke", "save", "search", "select", "send", "set", "show", "skip", "split",
                "start", "step", "stop", "submit", "suspend", "switch", "sync", "test", "trace",
                "unblock", "undo", "uninstall", "unlock", "unprotect", "unpublish", "unregister",
                "update", "use", "wait", "watch", "write"}
# An attached value that can only read a file (`-Fbody=@notes.md`, `-d@body.json`): no cmdlet
# parameter name holds `=` or `@`.
ATTACHED_FILE_READ = re.compile(r"-F[^=]*=[\"']?[@<]|-d[\"']?@")
# `env`'s options that take the next word as their value, each with the shortest prefix GNU env reads.
ENV_VALUE_OPTIONS = {"--unset": "--u", "--chdir": "--c", "--split-string": "--s", "--argv0": "--a"}
ENV_VALUE_SHORT = {"-u", "-C", "-S", "-a"}


def flag_values(words, short=(), message_flags=MESSAGE_FLAGS, value_letters=None, attached_only=None,
                file_letters=None):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}. The word after one of `message_flags` is that message's text,
    never a flag. With `value_letters`, so is the word after a git cluster ending in -m whose
    earlier letters take no value. With `attached_only`, a short flag's attached value is read
    only from a word that pattern matches."""
    cluster = re.compile(r"-(?:(?![m%s])[a-z])*m" % value_letters) if value_letters is not None else None
    # With `file_letters`, the value letters of a git subcommand that has -F (`commit`, `tag`), a
    # cluster ending in -F reads its file like -F alone: `-aF msg.txt`, `-aFmsg.txt`.
    file_cluster = None if file_letters is None else re.compile(r"-(?:(?![m%s])[a-z])+F(.*)" % file_letters)
    message = False
    for i, word in enumerate(words):
        text = text_of(word)
        if message or not text.startswith("-"):
            message = False
            continue
        built = isinstance(word, dict)
        message = (text in message_flags or text.lower() == "-body"  # PowerShell names are any case
                   or (cluster is not None and cluster.fullmatch(text) is not None))
        clustered = file_cluster.fullmatch(text) if file_cluster is not None else None
        if clustered and not clustered.group(1):
            yield "-F", words[i + 1] if i + 1 < len(words) else None
            continue
        if clustered:
            flag, value = "-F", clustered.group(1)
        elif text.startswith("--") and "=" in text:
            flag, value = text.split("=", 1)
        elif text[:2] in short and len(text) > 2 and (attached_only is None or attached_only.match(text)):
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


def body_files(words, flags=BODY_FLAGS, message_flags=MESSAGE_FLAGS, readers="@<", value_letters=None,
               attached_only=None, file_letters=None):
    """Every file the words' flags in `flags` name as a body; with `attached_only`, a short
    flag's attached value counts only in a word that pattern matches."""
    files = []
    for flag, value in flag_values(words, ATTACHED, message_flags, value_letters, attached_only, file_letters):
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
    # `-t` is commit's short `--template`; on checkout, branch and switch it means track.
    flags = GIT_FILE_FLAGS | {"-t"} if words[i] == "commit" else GIT_FILE_FLAGS
    # Only a subcommand whose value letters are all known reads a -F cluster (`-bFeature` is a branch).
    file_letters = GIT_VALUE_LETTERS.get(words[i]) if isinstance(words[i], str) else None
    return body_files(words[i:], flags, GIT_MESSAGE_FLAGS, value_letters=git_value_letters(words),
                      file_letters=file_letters)


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


def anchored(path):
    """Whether a path names one place from any folder. On Windows a path rooted without a
    drive (`/x`) is on the drive of the folder the command runs in."""
    return os.path.isabs(path) and bool(os.name != "nt" or os.path.splitdrive(path)[0])


def converted(path):
    """The file a drive path names in the shell that reads it, on Windows: `/p/x` once Git Bash
    converts it, or `/mnt/p/x` in a WSL `bash`, is `P:/x`. Git Bash leaves some arguments as
    written (conversion turned off, some spellings, a PowerShell call), and those land on the
    folder's own drive, so both are read."""
    match = GIT_BASH_DRIVE.match(path) if os.name == "nt" else None
    return [f"{match.group(1).upper()}:{path[match.end():] or '/'}"] if match else []


def resolve(value, places):
    """(path, error) for each file a body flag's value may name, or an error saying why it
    cannot be told before the command runs. A relative file is read in each of `places`
    that holds it, or in the first when none does; `places` is None after a folder change
    the command text cannot place."""
    if isinstance(value, dict):
        yield None, f"a body file named by text the shell builds at run time ({value.get('dynamic')})"
        return
    path = os.path.expanduser(value)
    if anchored(path):
        paths = [path]
    elif places is None:
        yield None, (f"a relative body file {value} after a folder change the command text cannot tell"
                     " (such as `cd -`, a target built at run time or a folder this computer cannot find)")
        return
    else:
        paths = [os.path.join(place, path) for place in places]
    paths += converted(path)
    yield from ((found, None) for found in [p for p in paths if os.path.isfile(p)] or paths[:1])


def is_cmdlet(name):
    """Whether a PowerShell command name is a cmdlet: an approved verb, a hyphen and a noun."""
    match = CMDLET.fullmatch(name)
    return bool(match) and match.group(1) in CMDLET_VERBS


def command_files(words, shell="bash"):
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
    # time names git (`timeout 5 $GIT commit`). Then git's -m is a message too.
    built_git = any(is_run_time_git(w) for w in words)
    flags = BODY_FLAGS if built_git else BODY_FLAGS - {"--template"}
    message = MESSAGE_FLAGS | (GIT_MESSAGE_FLAGS if "git" in names or built_git else set())
    letters = None if "git" not in names and not built_git else "".join(
        [ANY_VALUE_LETTERS] * built_git + [git_value_letters(run) for run in inner if program(run) == "git"])
    readers = "@" if "gh" in names else "@<"  # gh reads a form field's file only after =@
    # A PowerShell cmdlet's parameter is a whole name (`Stop-Process -Force`), never a flag with
    # its value written onto it, but a program it runs may still read a file that way.
    attached_only = ATTACHED_FILE_READ if shell == "powershell" and is_cmdlet(name) and not built_git else None
    return (body_files(words, flags, message, readers, letters, attached_only)
            + [f for run in inner for f in command_files(run, shell)])


def folder_targets(words):
    """The folders one command names to move to: a `cd`-style command's targets (home for a
    bare `cd`, none for `popd` or a bare `pushd`), or the `-C` folders of an env or a git it runs."""
    words = past_cd_wrapper(words)
    name = program(words)
    if name in CD_COMMANDS:
        targets = [w for w in words[1:] if text_of(w) == "-" or not text_of(w).startswith("-")]
        return targets or (["~"] if name in HOME_COMMANDS else [])
    # A text tool's `env` is a word it reads (`rg TODO env -C 3`), not a program it runs.
    envs = [] if name in TEXT_TOOLS else [folder for i in range(len(words)) if program(words[i:]) == "env"
                                          for folder in env_folders(words[i + 1:])]
    return envs + [folder for i in range(len(words)) if program(words[i:]) == "git" or is_run_time_git(words[i])
                   for folder in git_subcommand(words[i:])[1]]


def past_cd_wrapper(words):
    """The words after `builtin` or `command` (and `command -p`), which run the shell's own
    `cd`; `command -v` and `-V` only print, so their words stay as they are."""
    if program(words) == "builtin":
        return words[1:]
    if program(words) != "command":
        return words
    rest = words[1:]
    while rest and rest[0] == "-p":
        rest = rest[1:]
    return words if rest and text_of(rest[0]).startswith("-") else rest


def env_folders(args):
    """The folders `env -C <dir>` or `--chdir` moves its program to, read before that program. A
    word built at run time there that is not an assignment (`--chdir="$D"`, `$OPTS`) may name a
    folder, so it comes back as one, which `folder_places` cannot place."""
    folders, i = [], 0
    while i < len(args) and args[i] != "--":
        word, i = args[i], i + 1
        if not isinstance(word, str):
            if not re.match(r"\w+=", shape_of(word)):
                return folders + [word]
            continue
        if word.startswith("--"):
            name, has_value, value = word.partition("=")
            if abbreviates(name, "--chdir", ENV_VALUE_OPTIONS["--chdir"]):
                folders += [value] if has_value else args[i:i + 1]
            i += takes_next_word(word, ENV_VALUE_SHORT, ENV_VALUE_OPTIONS)
        elif word.startswith("-") and len(word) > 1:
            at = word.find("C")
            if at > 0 and all("-" + letter not in ENV_VALUE_SHORT for letter in word[1:at]):
                folders += [word[at + 1:]] if word[at + 1:] else args[i:i + 1]
            i += takes_next_word(word, ENV_VALUE_SHORT, ENV_VALUE_OPTIONS)
        elif not re.match(r"\w+=", word):
            break
    return folders


def is_run_time_git(word):
    """Whether a word built at run time names git (`$GIT`, `$(command -v git)`)."""
    return isinstance(word, dict) and GIT_WORD.search(text_of(word)) is not None


def folder_places(commands, cwd):
    """Every folder a command may run in: the start folder, and each folder a folder change
    in the command names, reached from any folder found before it in the text, since a `cd`
    may run in a child shell or fail, so the shell may be in any of them. The changes are then
    applied again until no folder is added, since a loop or a function may run a `cd` again.
    None when a target cannot be placed: one built at run time, or one this computer cannot
    find, such as a saved folder (`cd -`, `~-`) or a folder made later, or when the folders
    pass MAX_PLACES."""
    targets = [target for words in commands for target in folder_targets(words)]
    if not all(isinstance(target, str) for target in targets):
        return None
    places, seen, first = [cwd], {os.path.realpath(cwd)}, True
    while True:
        count = len(places)
        for target in map(os.path.expanduser, targets):
            reached = [target] if anchored(target) else [os.path.join(place, target) for place in places]
            reached += converted(target)
            found = [place for place in reached if os.path.isdir(place)]
            if first and not found:
                return None
            # A link keeps its own name in the first pass, since Windows reads `link\..` by name;
            # the repeated passes compare real paths, so a link back to a parent cannot keep adding.
            for place in found:
                if place not in places if first else os.path.realpath(place) not in seen:
                    seen.add(os.path.realpath(place))
                    places.append(place)
        if len(places) == count:
            return places
        if len(places) > MAX_PLACES:
            return None
        first = False


def parsed_files(groups, cwd):
    """(path, error) for every body file the parsed commands name, in order, each group of
    `with_nested` read as its shell reads it, a relative file in every folder it may run in."""
    for commands, placing, shell in groups:
        places = folder_places(placing, cwd)
        for words in commands:
            for value in command_files(words, shell):
                if value != "-":
                    yield from resolve(value, places)


def abbreviates(word, option, shortest):
    """Whether git reads `word` as the long option `option` (any prefix from `shortest` on)."""
    name = word.split("=", 1)[0]
    return len(name) >= len(shortest) and option.startswith(name)


def takes_next_word(word, short, long):
    """Whether an option reads the next word as its value: a long one by its name (`long` maps
    each to its shortest prefix), or a short cluster as getopt reads one, where only the last
    letter can and a value letter before it takes the rest of the word (`-iuFOO`)."""
    if word.startswith("--"):
        return "=" not in word and any(abbreviates(word, option, shortest) for option, shortest in long.items())
    letters = word[1:]
    first = next((i for i, letter in enumerate(letters) if "-" + letter in short), None)
    return first == len(letters) - 1 and not is_uncertain(word)


def is_uncertain(word):
    """Whether a bundle holds a part built at run time, a glob or a brace, so its letters at run time
    are unknown and none of them may be taken to read the next word (`-${Q}m -n`)."""
    return any(sign in word for sign in "\0*?[{")
