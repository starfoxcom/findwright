"""The attribution guard's shell reading: the parser in Bindwright's helper and the
command strings a nested shell runs."""
import json
import os
import re
import shutil
import subprocess
import time
from . import routes_in  # the hook file's own, set before this module loads


TEXT_TOOLS = {"awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq",
              "head", "tail", "wc", "jq", "column", "paste", "join", "select-string", "sls", "findstr"}
PARSE_SECONDS = 20  # one parse
MAX_NESTED_SHELLS = 3  # `bash -c` inside `bash -c` ... read this many levels deep
POSIX_SHELLS = {"bash", "sh", "dash", "zsh", "ksh", "mksh", "ash"}
WRAPPERS = {"sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "time", "xargs"}
NO_NODE = ("no Node 18 or later is on PATH outside this project's folders, and the guard's parser"
           " needs one to read the command (a node the project ships is never run). Install Node,"
           " or put one from outside the project on PATH, then run /bindwright:update.")
NO_HELPER = "Bindwright's helper, which holds the guard's parser, is missing. Run /bindwright:update to install it."
OLD_HELPER = "Bindwright's helper is older than this guard. Run /bindwright:update to update it."
UNREAD = ("the guard's parser could not read this command (an array built at run time, PowerShell's"
          " `--%`, or syntax it rejects). Write it as plain commands.")
NESTED_UNREAD = ("a shell here runs a command string built at run time (`bash -c \"$CMD\"`), one nested more"
                 f" than {MAX_NESTED_SHELLS} deep, or one given to a nested PowerShell (`pwsh -Command`), which"
                 " the guard cannot read. Run the command directly.")
SLOW = (f"the guard's parser did not answer within {PARSE_SECONDS} s, so the command was not read."
        " Run it again once the computer is less busy.")
BROKEN = ("the guard's parser failed to run, so the command was not read. Run /bindwright:update to"
          " reinstall Bindwright's helper.")


def parser_script():
    """The shell parser in Bindwright's helper, which setup installs per computer with npm
    or pip; None when neither copy is there."""
    helper = os.path.join(os.path.expanduser("~"), ".bindwright", "helper")
    folders = [os.environ.get("BINDWRIGHT_HELPER")] if os.environ.get("BINDWRIGHT_HELPER") else [
        os.path.join(helper, "node_modules", "bindwright"), os.path.join(helper, "python", "bindwright")]
    scripts = [os.path.join(folder, "hooks", "shell-words.mjs") for folder in folders]
    return next((script for script in scripts if os.path.isfile(script)), None)


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


def node_program(cwd):
    """`node` as an absolute path, from the first PATH folder a repo cannot have shipped it in,
    or None when no such folder holds one. A PATH folder that is relative (a `.`), is the session
    folder or the current folder, or sits in the folder repo_folder gives for it is skipped, so a
    repo's own `node` never runs; Windows's search of the current folder first is switched off."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    repo = repo_folder(cwd)
    here = {real_path(place) for place in (cwd, os.getcwd())}
    folders = {entry: resolved(entry) for entry in os.environ.get("PATH", "").split(os.pathsep)
               if os.path.isabs(entry)}
    trusted = [entry for entry, real in folders.items()
               if real and real not in here and not (repo and is_within(real, repo))]
    found = shutil.which("node", path=os.pathsep.join(trusted))
    return found if found and os.path.isabs(found) else None


def node_too_old(node, deadline):
    """Whether `node` is older than Node 18, which the parser needs; asked only once a run failed."""
    try:
        # Short, and never past the parses' deadline, so the hook answers before it is stopped.
        out = subprocess.run([node, "--version"], capture_output=True,
                             timeout=max(0.1, min(2, deadline - time.monotonic())))
    except (OSError, subprocess.TimeoutExpired):
        return False
    version = re.match(rb"\s*v(\d+)\.", out.stdout)
    return version is not None and int(version.group(1)) < 18


def parse(cmd, shell, cwd, deadline):
    """(each simple command's words, the variables the command sets, "") as the shell reads
    them (helper/hooks/shell-words.mjs); (None, None, why) when the parser is missing, older
    than this guard, fails, cannot read the command or has not answered by `deadline`."""
    node, script = node_program(cwd), parser_script()
    if not node:
        return None, None, NO_NODE
    if not script:
        return None, None, NO_HELPER
    if deadline <= time.monotonic():
        return None, None, SLOW
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=min(PARSE_SECONDS, deadline - time.monotonic()))
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return None, None, SLOW
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("commands"), list):
        return None, None, NO_NODE if node_too_old(node, deadline) else BROKEN
    if not all(isinstance(command, list) for command in data["commands"]):
        return None, None, BROKEN
    words = [word for command in data["commands"] for word in command]
    if not all(isinstance(word, (str, dict)) for word in words):
        return None, None, BROKEN
    if not isinstance(data.get("assignments"), list) or any(
            isinstance(word, dict) and not {"shape", "canBeEmpty", "canBeMany"} <= word.keys() for word in words):
        return None, None, OLD_HELPER
    if any(isinstance(word, dict) and not is_word_list(word.get("braces", [])) for word in words):
        return None, None, BROKEN
    if data.get("error"):
        return None, None, UNREAD
    return with_brace_readings(data["commands"]), data["assignments"], ""


def is_word_list(value):
    """Whether a reply's word list is a JSON list of strings, the one shape the guard reads."""
    return isinstance(value, list) and all(isinstance(each, str) for each in value)


def with_brace_readings(commands):
    """Each command, then, when a word of it is a brace of plain text, the same command with that
    word as bash expands it (`{-F,msg.txt}` is `-F msg.txt`). Both are checked, since a shell that
    does not expand braces (dash, `set +B`) runs the first and bash runs the second."""
    read = []
    for words in commands:
        read.append(words)
        if any(isinstance(word, dict) and "braces" in word for word in words):
            read.append([each for word in words for each in (
                word["braces"] if isinstance(word, dict) and "braces" in word else [word])])
    return read


def with_nested(commands, assignments, shell, cwd, deadline, found, depth=1, around=()):
    """(groups, assignments, ""): a group (commands, the commands that place their folders, shell)
    for the parsed commands, then one per command string a shell in them may run, whose folder
    changes move only its own group; (None, None, why) when one cannot be read. Adds each to found."""
    placing = list(around) + list(commands)
    groups, assignments = [(commands, placing, shell)], list(assignments)
    for inner_shell, strings in filter(None, (shell_strings(w[i:], shell) for w in commands for i in shell_places(w))):
        for text in strings:
            found.append(text_of(text))
            if not isinstance(text, str) or depth > MAX_NESTED_SHELLS:
                return None, None, NESTED_UNREAD
            inner, inner_assignments, problem = parse(text, inner_shell, cwd, deadline)
            if not problem:
                inner_groups, inner_assignments, problem = with_nested(
                    inner, inner_assignments, inner_shell, cwd, deadline, found, depth + 1, placing)
            if problem:
                return None, None, problem
            groups, assignments = groups + inner_groups, assignments + inner_assignments
    return groups, assignments, ""


def shell_strings(words, caller):
    """(parser shell, the command strings it may run) for a shell program: each argument of a
    POSIX shell whose text names a route, a dict when built at run time. PowerShell joins its
    arguments into a script the guard does not rebuild, so a route they name is a dict; a script
    block after options alone (`pwsh -c { ... }`) is read by the outer parse; None otherwise."""
    name, args = program(words), words[1:]
    if name in POSIX_SHELLS:
        return "bash", [w for w in args if routes_in(text_of(w))[1] or routes_in(shape_of(w))[1]]
    if name not in ("pwsh", "powershell"):
        return None
    args = args[:script_file_at(name, args)]
    last = args[-1] if args and caller == "powershell" and not isinstance(args[-1], str) else ""
    options = all(re.fullmatch(r"-[A-Za-z]+", text_of(w)) for w in args[:-1])
    if options and text_of(last).lstrip().startswith("{"):
        args = args[:-1]
    joined = " ".join(text_of(w) for w in args)
    return "powershell", [{"dynamic": joined}] if routes_in(joined)[1] else []


def script_file_at(name, args):
    """Index of the .ps1 file a nested PowerShell runs past no-value switches, whose later words
    are its parameters; `powershell` reads a first plain word as a command, so it needs `-File`."""
    named = name == "pwsh"
    for i, w in enumerate(args):
        option = w.lstrip("-").lower() if isinstance(w, str) and w.startswith("-") else None
        if option not in ("noprofile", "nop", "nologo", "noninteractive", "noni", "file", "f"):
            is_script = isinstance(w, str) and w.lower().endswith(".ps1") and not routes_in(w)[1]
            return i if named and is_script else len(args)
        named = named or option in ("file", "f")
    return len(args)


def shell_places(words):
    """Words a shell may start at: those before a git, gh or text tool first or after a wrapper."""
    end = next((i for i in range(len(words)) if program(words[i:]) not in WRAPPERS), len(words))
    data = [i for i in range(end + 1) if program(words[i:]) in {"git", "gh"} | TEXT_TOOLS
            and "=" not in words[i]]
    return range(data[0] if data else len(words))


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def shape_of(word):
    """A word's literal value, or its text with a NUL for each part built at run time: what an
    option reader may trust, whichever way the source spells the expansion (`$Q`, `"$Q"`, `${Q}`)."""
    return word if isinstance(word, str) else str(word["shape"])


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    # Windows runs `git.exe`, `git.cmd` and `git.bat` alike when the command says `git`.
    return re.sub(r"\.(exe|cmd|bat|com)$", "", name)
