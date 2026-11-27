r"""PostToolUse hook, observe mode: notes a pull request that adds a write to an outside
service without a `Live check:` line in its body.

testing.md asks for one real send of each new kind of write before the work is done, and the
pull request's body records it. After a `gh pr create` or `gh pr edit` prints the pull request's
address, this hook asks GitHub's API for that pull request's body and changed files, so the
branch, base and repo are the ones GitHub holds, never a guess from the command's text, and each
file's path and patch arrive as separate JSON fields, never parsed out of diff text. When a line
a file adds outside test files and the bind's record under .bindwright/ makes a write (an API
call with a write method, or an HTTP client's post, put, patch or delete) and the body has no
`Live check:` line, it appends the match to `<BINDWRIGHT_HOME>/live-check/observed.jsonl` and
hands the session one line of context.

It never blocks: every outcome exits 0, so the log shows how often the note fires before any
version refuses. Output with no github.com address, or with more than one, makes no note, and so
does a gh that fails or runs out of time; a pull request on a GitHub Enterprise host gets none.
"""

import datetime
import json
import os
import re
import shutil
import subprocess
import sys

NOTE = ("Live check: this PR adds a write to an outside service and its body has no `Live check:` "
        "line (testing.md § Test the real code)")
HOME_VARIABLE = "BINDWRIGHT_HOME"
LOG_PARTS = ("live-check", "observed.jsonl")
# Two gh calls at most, inside the 30 s the settings entry gives the hook.
GH_SECONDS = 10
MAX_MATCHES = 5
MAX_MATCH_CHARS = 200
# Past this a line is generated (a minified bundle, a source map), not code someone wrote, and
# the patterns' cost on it could outrun the hook's timeout.
MAX_LINE_CHARS = 500
SHELLS = {"Bash", "PowerShell"}
PR_COMMAND = re.compile(r"\bgh\s+pr\s+(?:create|edit)\b")
# gh prints the pull request's address on a line of its own. Only github.com is read, and the
# host is never taken from the output: gh hands an Enterprise token to any host it does not
# know, so a printed address must not choose where a request goes.
GITHUB_HOST = "github.com"
PR_ADDRESS = re.compile(r"https://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/pull/(\d+)")
WRITE_METHOD = r"(?:POST|PUT|PATCH|DELETE)"
WRITE_PATTERNS = [re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\bgh\s+api\b.*(?:-X|--method)[\s=,\"']+" + WRITE_METHOD + r"\b",
    r"\b_gh\(.*[\"']" + WRITE_METHOD + r"[\"']",
    r"\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\(",
    r"\bfetch\((?=.*\bmethod\s*:\s*[\"']?" + WRITE_METHOD + r"\b)",
)]
RECORD_FOLDER = ".bindwright"
TEST_FOLDERS = {"test", "tests", "__tests__", "spec"}
TEST_NAME_MARKERS = ("_test.", ".test.", ".spec.")
LIVE_CHECK_LINE = re.compile(r"(?:[-*] )?live check:", re.IGNORECASE)


def sends_nothing(path):
    """Whether a repo path holds text that never reaches a real service: a test file, or the
    bind's record under .bindwright/, which stores whole files as strings."""
    parts = path.lower().split("/")
    name = parts[-1]
    return (parts[0] == RECORD_FOLDER or any(part in TEST_FOLDERS for part in parts[:-1])
            or name.startswith("test_") or any(marker in name for marker in TEST_NAME_MARKERS))


def write_lines(files):
    """The lines the pull request's files add that make a write to an outside service.

    `files` is GitHub's list of changed files: each names its path in `filename` and holds its
    hunks in `patch`, so no line of content can be taken for a path. A hunk line ends only at
    `\n`; a form feed or `\r` inside one stays inside it."""
    added = []
    for changed in files:
        if not isinstance(changed, dict) or not isinstance(changed.get("filename"), str):
            continue
        patch = changed.get("patch")
        if sends_nothing(changed["filename"]) or not isinstance(patch, str):
            continue
        added += [line[1:].strip() for line in patch.split("\n")
                  if line.startswith("+") and len(line) <= MAX_LINE_CHARS]
    return [line for line in added if any(pattern.search(line) for pattern in WRITE_PATTERNS)]


def json_documents(text):
    """Every JSON document in `text` one after another, as `gh api --paginate` prints pages."""
    decoder, documents, index = json.JSONDecoder(), [], 0
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        document, index = decoder.raw_decode(text, index)
        documents.append(document)
    return documents


def has_live_check(body):
    """Whether a line of the body starts with `Live check:`, optionally as a list item."""
    return any(LIVE_CHECK_LINE.match(line) for line in body.split("\n"))


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


def repo_folder(start, follow_links=True):
    """The top folder of the outermost repo holding `start`, resolved, where a repo, or the one a
    submodule sits in, could ship its own programs. A repo at the home folder or above it holds
    the user's own installs and does not count, unless the home folder is unknown. Outside a
    repo it is `start` itself, or None when `start` is the home folder or above it. With
    `follow_links` false, the folders walked are the ones `start` was reached through. The walk
    keeps each folder's own spelling, so a folder Windows marks case-sensitive still finds its
    `.git`; only the folder given back is case-folded, for comparing."""
    home = os.path.expanduser("~")
    home = real_path(home) if os.path.isabs(home) else None
    folder = os.path.realpath(start) if follow_links else os.path.abspath(start)
    top, first = None, True
    while True:
        real = real_path(folder)
        counts = not (home and is_within(home, real))
        if counts and (first or os.path.exists(os.path.join(folder, ".git"))):
            top = real
        parent, first = os.path.dirname(folder), False
        if parent == folder:
            return top
        folder = parent


def trusted_folders(session):
    """The absolute PATH folders a repo cannot have shipped a program in, or None when the folders
    cannot be read, as when the current folder was deleted. A PATH folder that is relative (a `.`),
    is the session folder or the current folder, or sits in a folder repo_folder gives for the
    session folder, as reached or with its links followed, is skipped, and Windows's search of the
    current folder first is switched off.
    Every program a guard runs is found here, always from the session folder, never from a repo
    root found later, so every guard trusts the same folders."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        here = {real_path(place) for place in (session, os.getcwd())}
        repos = {repo_folder(session), repo_folder(session, follow_links=False)} - {None}
    except OSError:
        return None
    folders = {entry: resolved(entry) for entry in os.environ.get("PATH", "").split(os.pathsep)
               if os.path.isabs(entry)}
    return [entry for entry, real in folders.items()
            if real and real not in here and not any(is_within(real, repo) for repo in repos)]


def gh(folders, *args):
    """What the gh in the trusted `folders` prints, decoded from its bytes so no line ending is
    rewritten, or None when none of them holds one, or it fails or runs out of time."""
    found = folders and shutil.which("gh", path=os.pathsep.join(folders))
    if not found or not os.path.isabs(found):
        return None
    # gh starts git itself, so its PATH holds only the trusted folders.
    env = dict(os.environ, PATH=os.pathsep.join(folders))
    try:
        done = subprocess.run([found, *args], capture_output=True, timeout=GH_SECONDS, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.decode("utf-8", "replace") if done.returncode == 0 else None


def pr_address(event):
    """(owner/repo, number) of the github.com address a `gh pr create` or `gh pr edit` printed, or
    None for any other call."""
    if not isinstance(event, dict) or event.get("tool_name") not in SHELLS:
        return None
    tool_input = event.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not PR_COMMAND.search(command):
        return None
    response = event.get("tool_response")
    if isinstance(response, dict):
        response = response.get("stdout") if isinstance(response.get("stdout"), str) else response.get("output")
    if not isinstance(response, str):
        return None
    addresses = [PR_ADDRESS.fullmatch(line.strip()) for line in response.split("\n")]
    addresses = [address.groups() for address in addresses if address]
    return addresses[0] if len(addresses) == 1 else None


def record(address, matches):
    """Appends one JSON line describing the note to the log."""
    home = os.environ.get(HOME_VARIABLE) or os.path.join(os.path.expanduser("~"), ".bindwright")
    folder = os.path.join(home, LOG_PARTS[0])
    os.makedirs(folder, exist_ok=True)
    entry = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "pull_request": address,
        "matches": [line[:MAX_MATCH_CHARS] for line in matches[:MAX_MATCHES]],
    }
    with open(os.path.join(folder, LOG_PARTS[1]), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def read_pull_request(folders, repo, number):
    """(the body, the changed files) github.com holds for the pull request, or None when gh cannot
    read them. Both come as JSON, whose strings keep every character of the text."""
    path = "repos/%s/pulls/%s" % (repo, number)
    pull = gh(folders, "api", "--hostname", GITHUB_HOST, path)
    files = gh(folders, "api", "--hostname", GITHUB_HOST, "--paginate", path + "/files") if pull is not None else None
    if files is None:
        return None
    body = json.loads(pull).get("body") or ""
    return body, [changed for page in json_documents(files) for changed in page]


def observe(event):
    """Records the pull request when it adds an unchecked write; returns whether it did."""
    address = pr_address(event)
    if not address:
        return False
    session = event.get("cwd")
    folders = trusted_folders(session if isinstance(session, str) and session else os.getcwd())
    pull_request = read_pull_request(folders, *address)
    if pull_request is None or has_live_check(pull_request[0]):
        return False
    matches = write_lines(pull_request[1])
    if not matches:
        return False
    record("https://%s/%s/pull/%s" % (GITHUB_HOST, *address), matches)
    return True


def main():
    try:
        noted = observe(json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")))
    except Exception:  # observe mode: no failure of this hook may block the tool call
        return 0
    if noted:
        # Claude Code shows the session a hook's additionalContext; stderr on exit 0 it drops.
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": NOTE}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
