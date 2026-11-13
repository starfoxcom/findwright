"""Lists the pinned versions in the workflows that are behind the newest releases.

Pins keep a PR's result stable; this says when they fall behind. The weekly
pin-check workflow looks up the newest releases and passes them in:

    pin_check.py --cli 2.1.310 --action-sha <40 hex> --action-version v1.0.220 FILE...

Prints a Markdown list of the pins that are behind, one line per pinned value
with every place it is pinned, or nothing when every pin is current. Exits 1 on
bad arguments or a file it cannot read.

Pins it reads:
- the CLI version a workflow installs: `CLI_VERSION: "2.1.300"` or
  `PINNED_VERSION: "2.1.299"`;
- the review action's commit: `uses: anthropics/claude-code-action@<sha>`, with
  the version it names in the comment after it.

It also lists every action a workflow uses by a tag or branch instead of a
commit (`uses: actions/checkout@v6`): a tag can be moved to other code.

The deep review runs it on a PR's diff to look up, on GitHub, each action pin
the PR adds, since the reviewer's own tools cannot reach other repos:

    git diff BASE...HEAD -- '*.yml' '*.yaml' | pin_check.py added

Prints a Markdown line per added pin, verified when a release tag its comment
names points to its commit and not verified otherwise, or nothing when the
diff adds no pin.
"""

import json
import re
import subprocess
import sys
import time

CLI = re.compile(r'^\s*(?:CLI_VERSION|PINNED_VERSION):\s*"?(\d+(?:\.\d+)*)"?\s*(?:#.*)?$')
ACTION = re.compile(r"^\s*(?:-\s+)?uses:\s*anthropics/claude-code-action@([0-9a-f]{40})\b(?:\s*#\s*(.*))?$")
DOCKER = re.compile(r"^\s*(?:-\s+)?uses:\s*['\"]?docker://([^\s'\"#]+)")
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*['\"]?([\w.-]+/[\w./-]+)@([^\s'\"#]+)")
VERSION = re.compile(r"\d+(?:\.\d+)*")
SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}")
TAG = re.compile(r"(?<![\w.-])(v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)(?![\w.-])", re.ASCII)
MAX_TAG_LENGTH = 40
MAX_PINS = 40
MAX_TAGS = 4
MAX_PEELS = 3
SEPARATORS = " \t\r"


def _tuple(version):
    return tuple(int(p) for p in version.split("."))


def pins(name, text):
    """[(kind, value, label, "file:line")] for every pin in one file."""
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        m = CLI.match(line)
        if m:
            found.append(("cli", m.group(1), m.group(1), "%s:%d" % (name, n)))
            continue
        m = ACTION.match(line)
        if m:
            label = (m.group(2) or "").strip() or m.group(1)[:12]
            found.append(("action", m.group(1), label, "%s:%d" % (name, n)))
    return found


def floating(name, text):
    """["owner/repo@ref at file:line"] for every action used by a ref that is not a commit."""
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        m = USES.match(line)
        commit = SHA.fullmatch(m.group(2)) if m else None
        if m and not (commit and ends_value(line, m)):
            # A commit id with text glued after it is shown with that text, the ref the runner uses.
            ref = line[m.start(2):].split()[0] if commit else m.group(2)
            found.append("`%s@%s` at `%s:%d`" % (m.group(1), ref, name, n))
            continue
        m = DOCKER.match(line)
        if m and "@sha256:" not in m.group(1):
            found.append("`docker://%s` at `%s:%d`" % (m.group(1), name, n))
    return found


def ends_value(text, m):
    """True when the YAML value ends right after the commit id (or the closing quote of a
    quoted value), with only YAML's separators (space, tab, CR) and a `#` comment after it.
    Anything else on the line (`#x` glued on, a no-break space, a second word) is part of
    the ref the runner uses, so that ref is not the commit."""
    rest = text[m.end(2):]
    opened = text[m.start(1) - 1] if text[m.start(1) - 1] in "'\"" else ""
    if opened:
        if rest[:1] != opened:
            return False
        rest = rest[1:]
    after = rest.lstrip(SEPARATORS)
    return not after or (after.startswith("#") and len(after) < len(rest))


def added_pins(diff):
    """[(owner/repo, sha, [tags])] for each action a diff adds by commit, with
    the first MAX_TAGS release tags its comment names (`# v6 (v6.1.0)`). Only
    these checked fields leave the diff: no file name or other PR text."""
    found = []
    for line in diff.split("\n"):
        m = USES.match(line[1:]) if line.startswith("+") else None
        if not m or not SHA.fullmatch(m.group(2)) or not ends_value(line[1:], m):
            continue
        repo = "/".join(m.group(1).split("/")[:2])
        if not REPO.fullmatch(repo) or any(p in (".", "..") for p in m.group(1).split("/")):
            continue
        tags = [t for t in dict.fromkeys(TAG.findall(line.partition("#")[2])) if len(t) <= MAX_TAG_LENGTH]
        tags = tags[:MAX_TAGS]
        entry = (repo, m.group(2), tags)
        if entry not in found:
            found.append(entry)
    return found


def tag_commit(repo, tag, fetch):
    """The commit a release tag points to, peeling annotated tags; None when the
    tag is missing or does not end at a commit. `fetch(path)` returns the API's
    JSON, or None on 404."""
    obj = _object(fetch("repos/%s/git/ref/tags/%s" % (repo, tag)))
    for _ in range(MAX_PEELS):
        if not obj or obj["type"] != "tag":
            break
        obj = _object(fetch("repos/%s/git/tags/%s" % (repo, obj["sha"])))
    return obj["sha"] if obj and obj["type"] == "commit" else None


def _object(reply):
    """A reply's `object` as {"type", "sha"} when its id is a full commit-style id, else None."""
    obj = reply.get("object") if isinstance(reply, dict) else None
    if isinstance(obj, dict) and isinstance(obj.get("sha"), str) and SHA.fullmatch(obj["sha"]):
        return {"type": obj.get("type"), "sha": obj["sha"]}
    return None


def provenance(found, fetch):
    """A Markdown line per added pin with the workflow's verdict: verified when a
    release tag its comment names points to its commit. Each (repo, tag) is
    looked up once, however many pins name it."""
    lines, cache = [], {}
    for repo, sha, tags in found[:MAX_PINS]:
        verdict = "not verified: its comment names no release tag" if not tags else ""
        for tag in tags:
            if (repo, tag) not in cache:
                try:
                    cache[repo, tag] = tag_commit(repo, tag, fetch)
                except LookupError:
                    cache[repo, tag] = LookupError
            if cache[repo, tag] == sha:
                verdict = "verified: tag `%s` points to this commit" % tag
                break
            if cache[repo, tag] is LookupError:
                verdict = "not verified: a lookup failed"
        lines.append("- `%s@%s`: %s." % (repo, sha, verdict or "not verified: no tag it names points to this commit"))
    if len(found) > MAX_PINS:
        lines.append("- %d more pins were not looked up." % (len(found) - MAX_PINS))
    return "".join(line + "\n" for line in lines)


def gh_fetch(path):
    """`gh api <path>` as JSON; None on 404. Tries twice, then raises LookupError."""
    for attempt in range(2):
        try:
            out = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            out = None
        if out is not None and out.returncode == 0:
            try:
                return json.loads(out.stdout)
            except ValueError:
                pass
        elif out is not None and "HTTP 404" in out.stderr:
            return None
        if attempt == 0:
            time.sleep(3)
    raise LookupError(path)


def behind(found, cli, action_sha):
    """The pins older than the newest CLI or not on the newest action commit,
    grouped by pinned value: [(kind, label, [places])] in first-seen order."""
    groups = {}
    for kind, value, label, place in found:
        old = _tuple(value) < _tuple(cli) if kind == "cli" else value != action_sha
        if old:
            groups.setdefault((kind, value), [label, []])[1].append(place)
    return [(kind, label, places) for (kind, _), (label, places) in groups.items()]


def report(stale, cli, action_version):
    newest = {"cli": "CLI " + cli, "action": "action " + action_version}
    what = {"cli": "CLI", "action": "Review action"}
    return "".join("- %s `%s` is behind the newest %s: %s\n"
                   % (what[kind], label, newest[kind], ", ".join("`%s`" % p for p in places))
                   for kind, label, places in stale)


def _option(args, name):
    if name not in args or args.index(name) + 1 == len(args):
        raise ValueError("%s needs a value" % name)
    i = args.index(name)
    value = args[i + 1]
    del args[i:i + 2]
    return value


def main(argv):
    args = list(argv)
    if args == ["added"]:
        sys.stdout.write(provenance(added_pins(sys.stdin.read()), gh_fetch))
        return 0
    try:
        cli = _option(args, "--cli")
        sha = _option(args, "--action-sha")
        version = _option(args, "--action-version")
        if not VERSION.fullmatch(cli) or not SHA.fullmatch(sha) or not args:
            raise ValueError("usage: pin_check.py --cli X.Y.Z --action-sha SHA --action-version V FILE...")
        found, unpinned = [], []
        for name in args:
            with open(name, encoding="utf-8") as fh:
                text = fh.read()
            found += pins(name, text)
            unpinned += floating(name, text)
    except (ValueError, OSError) as e:
        print("pin_check: %s" % e, file=sys.stderr)
        return 1
    sys.stdout.write(report(behind(found, cli, sha), cli, version))
    sys.stdout.write("".join("- Action %s is not pinned to a commit\n" % u for u in unpinned))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
