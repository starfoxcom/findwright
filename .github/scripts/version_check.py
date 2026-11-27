#!/usr/bin/env python3
"""Refuses a release whose version is smaller than its commits require.

Reads the commits since the newest stable release tag reachable from --ref, other than
a tag of NEW_VERSION itself, and checks NEW_VERSION against them:

    version_check.py NEW_VERSION [--scheme semver|calver] [--format YYYY.MM.MICRO]
                     [--changelog CHANGELOG.md] [--ref HEAD]

Without --scheme, the scheme and the calver format come from `advanced.versioning`
and `advanced.versionFormat` in .bindwright/project.json, and semver without it.

semver reads the commits as Conventional Commits: a `<type>!:` header or a
`BREAKING CHANGE:` body line needs a major, `feat` a minor, `fix` and `perf` a
patch. Before 1.0.0 a major counts as a minor and a minor as a patch. The
release's section in the changelog (Keep a Changelog, `## [vNEW]` or `## [NEW]`)
must hold the headings its size needs. The changelog is CHANGELOG.md in the repo's
top folder when that file exists, and is not checked when it does not. The check runs
from the top folder, so it works from any folder inside the repo.

semver orders versions as SemVer 2.0.0 does: a pre-release (`1.3.0-beta.1`) sorts after the
release before it and before its own release, and build metadata (`+build.5`) is ignored.
NEW must sort after the newest tag of any kind, pre-releases included. A pre-release's size
is measured against the newest stable tag, and its changelog section is not checked: that
waits for the release. With no stable tag, only the sort check runs.

calver checks that NEW fits --format (calver.org tokens joined by dots) and
sorts after the last tag, and nothing else.

Prints nothing and exits 0 when the version is allowed. Prints one line per
reason and exits 2 when it is not. Exits 1 on bad arguments or a git or file
error, with the message on stderr. With no earlier tag it says so and exits 0.
"""

import argparse
import functools
import json
import os
import re
import shutil
import subprocess
import sys
from typing import NamedTuple

RANK = {"none": 0, "patch": 1, "minor": 2, "major": 3}
SIZE_NAMES = ("major", "minor", "patch")
TYPE_LEVEL = {"feat": "minor", "fix": "patch", "perf": "patch"}
DEMOTED = {"major": "minor", "minor": "patch"}
HEADER = re.compile(r"^(?P<type>[a-z]+)(?:\([^()]*\))?(?P<bang>!)?: \S")
BREAKING = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)
# SemVer 2.0.0 section 9 and 10: no leading zero in a numeric pre-release identifier.
SEMVER_IDENTIFIER = r"(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER = re.compile(
    r"(\d+)\.(\d+)\.(\d+)(?:-(%s(?:\.%s)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    % (SEMVER_IDENTIFIER, SEMVER_IDENTIFIER),
    re.ASCII,
)
# The pre-release key of a release: it sorts above every pre-release of its version.
RELEASE = (1,)
PATCH_HEADINGS = {"Fixed", "Security"}
MAX_LISTED = 5
# calver.org tokens: the regex each one matches, and its range when it is a date part.
CALVER_TOKENS = {
    "YYYY": (r"\d{4}", None),
    "YY": (r"\d{1,2}", None),
    "0Y": (r"\d{2}", None),
    "MM": (r"\d{1,2}", (1, 12)),
    "0M": (r"\d{2}", (1, 12)),
    "WW": (r"\d{1,2}", (1, 53)),
    "0W": (r"\d{2}", (1, 53)),
    "DD": (r"\d{1,2}", (1, 31)),
    "0D": (r"\d{2}", (1, 31)),
    "MINOR": (r"\d+", None),
    "MICRO": (r"\d+", None),
}


class CheckError(Exception):
    """A bad argument, or a git or file error: exit 1."""


class Commit(NamedTuple):
    short: str
    subject: str
    body: str


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(1, "version_check: %s\n" % message)


def parse_args(argv):
    parser = Parser()
    parser.add_argument("version", metavar="NEW_VERSION")
    parser.add_argument("--scheme", choices=("semver", "calver"))
    parser.add_argument("--format", help="calver format, such as YYYY.MM.MICRO")
    parser.add_argument("--changelog", help="default CHANGELOG.md when that file exists")
    parser.add_argument("--ref", default="HEAD")
    return parser.parse_args(argv)


@functools.lru_cache(maxsize=None)
def git_program():
    """git as an absolute path, found once from the folder the check started in, in the first PATH
    folder a repo cannot have shipped it in. A PATH folder that is relative, is that folder, or
    sits in the folder repo_folder gives for it is skipped, so a repo's own `git` never runs; Windows's search of
    the current folder first is switched off."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    here, repo = real_path(os.getcwd()), repo_folder(os.getcwd())
    folders = {entry: resolved(entry) for entry in os.environ.get("PATH", "").split(os.pathsep)
               if os.path.isabs(entry)}
    trusted = [entry for entry, real in folders.items()
               if real and real != here and not (repo and is_within(real, repo))]
    found = shutil.which("git", path=os.pathsep.join(trusted))
    if not found or not os.path.isabs(found):
        raise CheckError("no git found on PATH outside this repo's folders")
    return found


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


def git(*args):
    done = subprocess.run([git_program(), *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=False)
    if done.returncode != 0:
        raise CheckError(done.stderr.strip() or "git %s failed" % args[0])
    return done.stdout


def move_to_root(args):
    """Runs the check from the repo's top folder, so its files (the saved answers, the
    changelog) are found from any folder inside it. A given --changelog keeps meaning the
    file it names. A bare repo has no top folder and no such files, so it stays put."""
    if args.changelog is not None:
        args.changelog = os.path.abspath(args.changelog)
    done = subprocess.run([git_program(), "rev-parse", "--show-toplevel"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace", check=False)
    if done.returncode == 0 and done.stdout.strip():
        os.chdir(done.stdout.strip())


def use_saved_answers(args):
    """Fills --scheme, and --format for calver, from the project's saved answers."""
    if args.scheme is not None:
        return
    args.scheme = "semver"
    try:
        with open(os.path.join(".bindwright", "project.json"), encoding="utf-8") as fh:
            advanced = json.load(fh).get("advanced")
    except (OSError, ValueError, AttributeError):
        return
    if not isinstance(advanced, dict) or advanced.get("versioning") != "calver":
        return
    args.scheme = "calver"
    if args.format is None and isinstance(advanced.get("versionFormat"), str):
        args.format = advanced["versionFormat"]


def strip_v(text):
    return text[1:] if text.startswith("v") else text


def calver_tokens(args):
    """The --format tokens for calver, None for semver."""
    if args.scheme == "semver":
        if args.format is not None:
            raise CheckError("--format applies only to --scheme calver")
        return None
    if args.format is None:
        raise CheckError("--scheme calver needs --format")
    tokens = args.format.split(".")
    unknown = [t for t in tokens if t not in CALVER_TOKENS]
    if unknown:
        raise CheckError("unknown calver token(s): %s" % ", ".join(unknown))
    return tokens


def pre_key(pre):
    """Sorts a pre-release: numbers before words, numbers by value, a longer list last."""
    if pre is None:
        return RELEASE
    parts = pre.split(".")
    return (0,) + tuple((0, int(part)) if part.isdigit() else (1, part) for part in parts)


def parse_semver(text):
    m = SEMVER.fullmatch(text)
    if m is None:
        return None
    return tuple(int(n) for n in m.group(1, 2, 3)), pre_key(m.group(4))


def parse_calver(text, tokens):
    """The version's numbers as a tuple, or None when it does not fit the format."""
    pattern = r"\.".join("(%s)" % CALVER_TOKENS[t][0] for t in tokens)
    m = re.fullmatch(pattern, text, re.ASCII)
    if not m:
        return None
    numbers = tuple(int(n) for n in m.groups())
    for token, number in zip(tokens, numbers):
        bounds = CALVER_TOKENS[token][1]
        if bounds and not bounds[0] <= number <= bounds[1]:
            return None
    return numbers


def parse(text, scheme, tokens):
    """The version as a sortable key (numbers, pre-release key), or None when it does not fit.

    Build metadata is dropped, so it never changes an order or an equality.
    """
    if scheme == "semver":
        return parse_semver(text)
    numbers = parse_calver(text, tokens)
    return None if numbers is None else (numbers, RELEASE)


def is_stable(version):
    return version[1] == RELEASE


def release_tags(ref, scheme, tokens, new):
    """(version, tag) of each release tag reachable from ref.

    A tag of the new version itself is skipped, so a release made from a tag that
    already exists is checked against the release before it.
    """
    releases = []
    for tag in git("tag", "--merged", ref).split():
        version = parse(strip_v(tag), scheme, tokens)
        if version is not None and version != new:
            releases.append((version, tag))
    return releases


def newest(releases):
    """(tag, version) of the newest of the (version, tag) pairs."""
    version, tag = max(releases)
    return tag, version


def read_commits(last_tag, ref):
    """The non-merge commits from last_tag to ref, skipping GitHub's merge lines."""
    out = git("log", "%s..%s" % (last_tag, ref), "--no-merges", "--format=%H%x00%s%x00%b%x1e")
    commits = []
    for record in out.split("\x1e"):
        fields = record.lstrip("\n").split("\x00")
        if len(fields) != 3 or fields[1].startswith("Merge pull request"):
            continue
        commits.append(Commit(fields[0][:7], fields[1], fields[2]))
    return commits


def commit_type(subject):
    header = HEADER.match(subject)
    return header.group("type") if header else None


def commit_level(subject, body, pre_1):
    """The size one commit needs: major, minor, patch or none."""
    header = HEADER.match(subject)
    if (header and header.group("bang")) or BREAKING.search(body):
        level = "major"
    else:
        level = TYPE_LEVEL.get(commit_type(subject), "none")
    return DEMOTED.get(level, level) if pre_1 else level


def size_of(new, last):
    """The part of the version that grew first: major, minor or patch. NEW is after LAST."""
    return SIZE_NAMES[next(i for i, (n, o) in enumerate(zip(new, last)) if n != o)]


def listing(commits):
    shown = ["%s %s" % (c.short, c.subject) for c in commits[:MAX_LISTED]]
    if len(commits) > MAX_LISTED:
        shown.append("and %d more" % (len(commits) - MAX_LISTED))
    return "; ".join(shown)


def find_section(text, bare):
    """The changelog section for the version, or None when there is none."""
    m = re.search(r"^## \[v?%s\].*$" % re.escape(bare), text, re.MULTILINE)
    if not m:
        return None
    nxt = re.search(r"^## ", text[m.end():], re.MULTILINE)
    return text[m.end():m.end() + nxt.start()] if nxt else text[m.end():]


def changelog_reasons(source, bare, size, commits, pre_1):
    """What the version's changelog section lacks or must not hold. Before 1.0.0 each size
    carries one step more: a minor may break, and a patch may add."""
    path, text = source
    section = find_section(text, bare)
    if section is None:
        return ["%s: no section for %s" % (path, bare)]
    headings = set(re.findall(r"^### ([^\n]+?)[ \t]*$", section, re.MULTILINE))
    breaks = any(commit_level(c.subject, c.body, False) == "major" for c in commits)
    may_break = size == "major" or (pre_1 and size == "minor")
    reasons = []
    if (breaks or (size == "major" and not pre_1)) and "Breaking" not in headings:
        reasons.append("a breaking change needs ### Breaking" if breaks
                       else "a major needs ### Breaking")
    if not may_break and "Breaking" in headings:
        reasons.append("a %s must not have ### Breaking" % size)
    if size == "patch" and not pre_1 and headings - PATCH_HEADINGS:
        extra = ", ".join("### " + h for h in sorted(headings - PATCH_HEADINGS))
        reasons.append("a patch may hold only ### Fixed and ### Security, not %s" % extra)
    has_feat = any(commit_type(c.subject) == "feat" for c in commits)
    if has_feat and not headings & {"Added", "Changed"}:
        reasons.append("a feat commit needs ### Added or ### Changed")
    return ["%s: %s" % (path, reason) for reason in reasons]


def bare_version(text):
    """The version without its v prefix or build metadata: the name of its changelog heading."""
    return strip_v(text).split("+", 1)[0]


def semver_reasons(args, new, stable):
    stable_tag, stable_version = stable
    size = size_of(new[0], stable_version[0])
    pre_1 = stable_version[0][0] == 0
    commits = read_commits(stable_tag, args.ref)
    levels = [commit_level(c.subject, c.body, pre_1) for c in commits]
    required = max(levels, key=RANK.get, default="none")
    reasons = []
    if RANK[size] < RANK[required]:
        needing = [c for c, level in zip(commits, levels) if level == required]
        reasons.append("%s is a %s, but its commits need a %s: %s"
                       % (args.version, size, required, listing(needing)))
    source = changelog_source(args)
    if source is not None and is_stable(new):
        reasons += changelog_reasons(source, bare_version(args.version), size, commits, pre_1)
    return reasons


def commit_of(ref):
    return git("rev-parse", "--verify", "--quiet", ref + "^{commit}").strip()


def changelog_source(args):
    """(name, text) of the changelog: a given --changelog file; CHANGELOG.md in the working tree
    when --ref is the commit checked out; else CHANGELOG.md as it is at --ref, the commit being
    released. None when there is none."""
    path = args.changelog
    if path is None and commit_of(args.ref) == commit_of("HEAD"):
        path = "CHANGELOG.md" if os.path.exists("CHANGELOG.md") else None
        if path is None:
            return None
    if path is not None:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return path, fh.read()
    blob = "%s:CHANGELOG.md" % args.ref
    exists = subprocess.run([git_program(), "cat-file", "-e", blob], capture_output=True,
                            check=False)
    return ("CHANGELOG.md", git("show", blob)) if exists.returncode == 0 else None


def report(reasons):
    for reason in reasons:
        print(reason)
    return 2 if reasons else 0


def check(args):
    move_to_root(args)
    use_saved_answers(args)
    tokens = calver_tokens(args)
    new = parse(strip_v(args.version), args.scheme, tokens)
    if new is None:
        expected = args.format or "X.Y.Z[-pre][+build]"
        return report(["%s does not fit %s %s" % (args.version, args.scheme, expected)])
    if git("rev-parse", "--is-shallow-repository").strip() == "true":
        raise CheckError("this clone is shallow, so earlier release tags may be missing; "
                         "run git fetch --unshallow --tags, then check again")
    releases = release_tags(args.ref, args.scheme, tokens, new)
    if not releases:
        print("first release: no earlier tag to compare %s with" % args.version)
        return 0
    last_tag, last_version = newest(releases)
    if new <= last_version:
        return report(["%s is not after %s" % (args.version, last_tag)])
    if args.scheme == "calver":
        return 0
    stable = [release for release in releases if is_stable(release[0])]
    if not stable:
        return 0
    return report(semver_reasons(args, new, newest(stable)))


def main(argv):
    # Commit subjects can hold any character, and a console's own code page may not.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        return check(parse_args(argv))
    except (CheckError, OSError) as e:
        print("version_check: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
