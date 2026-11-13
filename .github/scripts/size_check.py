#!/usr/bin/env python3
"""Code-size check with a ratchet.

Measures the mechanical rows of `.claude/rules/code-size.md` against its own
tables, so the limits live in one place: file length, line length, and, per
function, length, cyclomatic complexity and parameter count. Nesting depth,
lambdas and the rule's exceptions are left to review.

A hard breach listed in `.github/size-check/baseline.txt` is tolerated while
it does not grow; a new breach, or growth of a listed one, fails. Breaches
the project accepts for good go in `.github/size-check/exceptions.txt` with a
reason. Both files hold `path|construct|name|value-or-reason` lines, `#` for
comments; `*` as the name covers every name in that file and construct.

Usage:
  python3 .github/scripts/size_check.py                  # exit 1 on a new or grown breach
  python3 .github/scripts/size_check.py --write-baseline # record today's hard breaches
  python3 .github/scripts/size_check.py --report         # also list tolerated and soft ones

Function rows need lizard (pip install lizard), from this Python or from the
environment setup installs it in, LIZARD_VENV. Without it they are skipped
and the check fails, so a missing row never reads as a pass.
"""

import argparse
import functools
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
RULE = os.path.join(ROOT, ".claude", "rules", "code-size.md")
BASELINE = os.path.join(ROOT, ".github", "size-check", "baseline.txt")
EXCEPTIONS = os.path.join(ROOT, ".github", "size-check", "exceptions.txt")
# Where setup installs lizard when this Python refuses `pip install --user`
# because the system or Homebrew manages it (PEP 668).
LIZARD_VENV = os.path.join(os.path.expanduser("~"), ".bindwright", "size-check-venv")

# The extensions each row of the rule's language table covers. "Other" takes
# every extension in the rule's `paths:` list that no named row claims.
LANGUAGE_EXTENSIONS = {
    "C / C++": (".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"),
    "C# / Java / Kotlin": (".cs", ".java", ".kt", ".kts"),
    "Dart": (".dart",),
    "GDScript": (".gd",),
    "Go": (".go",),
    "JavaScript / TypeScript": (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"),
    "Python": (".py",),
    "Rust": (".rs",),
}
# Generated and vendored code is out of scope (exception 1).
SKIP_DIRS = {"node_modules", "vendor", "third_party", "dist", "build", "generated"}
TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs"}
TEST_NAME = re.compile(r"^test_|_test\.|\.test\.|\.spec\.|_spec\.")
TEST_FILE_FACTOR = 1.5


def limit_pair(cell):
    """(soft, hard) from a cell such as "800 (.h 400) / 1 500 (.h 800)".
    Variants in parentheses are left to review."""
    plain = re.sub(r"\([^)]*\)", "", cell)
    plain = re.sub(r"(?<=\d) (?=\d{3}\b)", "", plain)
    numbers = [int(n) for n in re.findall(r"\d+", plain)]
    return (numbers[0], numbers[1]) if len(numbers) >= 2 else None


def rule_extensions(text):
    """Every extension the rule's `paths:` frontmatter names."""
    head = text.split("\n---", 2)[0] if text.startswith("---") else ""
    found = []
    for braces in re.findall(r"\*\.\{([^}]*)\}", head):
        found += ["." + e.strip() for e in braces.split(",") if e.strip()]
    found += ["." + e for e in re.findall(r"\*\.([A-Za-z0-9]+)\b", head)]
    return sorted(set(found))


def table_rows(text):
    """Cells of every Markdown table row that is not a header or separator."""
    rows = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not line.lstrip().startswith("|") or cells[0] in ("Construct", "Language"):
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        rows.append(cells)
    return rows


def read_rule(text):
    """({"params": pair, "ccn": pair}, {ext: {"file", "function", "line"}}, notes)."""
    shared, by_ext, notes, other, claimed = {}, {}, [], None, set()
    for cells in table_rows(text):
        if len(cells) == 3 and cells[0].startswith("Parameters"):
            shared["params"] = limit_pair(cells[1] + " / " + cells[2])
        elif len(cells) == 3 and cells[0].startswith("Cyclomatic"):
            shared["ccn"] = limit_pair(cells[1] + " / " + cells[2])
        elif len(cells) == 4:
            limits = {"file": limit_pair(cells[1]), "function": limit_pair(cells[2]), "line": limit_pair(cells[3])}
            if cells[0] == "Other":
                other = limits
            elif cells[0] in LANGUAGE_EXTENSIONS:
                by_ext.update({e: limits for e in LANGUAGE_EXTENSIONS[cells[0]]})
                claimed.update(LANGUAGE_EXTENSIONS[cells[0]])
            else:
                notes.append(f"the rule's row {cells[0]!r} names no known extensions; add it to LANGUAGE_EXTENSIONS")
    if other:
        # Every listed extension without a row of its own, so a language the
        # rule's table leaves out is still measured.
        by_ext.update({e: other for e in rule_extensions(text) if e not in claimed})
    return shared, by_ext, notes


def is_test(path):
    parts = path.split("/")
    return any(p in TEST_DIRS for p in parts[:-1]) or TEST_NAME.search(parts[-1]) is not None


def tracked_files(by_ext):
    # -z: paths come back raw, not quoted and escaped when they hold non-ASCII.
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True, check=True,
                         encoding="utf-8")
    return [f for f in out.stdout.split("\0")
            if os.path.splitext(f)[1] in by_ext and not SKIP_DIRS.intersection(f.split("/")[:-1])]


def venv_site_packages():
    """The site-packages folders of LIZARD_VENV, in its Windows and POSIX layouts."""
    return (glob.glob(os.path.join(LIZARD_VENV, "Lib", "site-packages"))
            + sorted(glob.glob(os.path.join(LIZARD_VENV, "lib", "python3*", "site-packages"))))


@functools.lru_cache(maxsize=None)
def import_lizard():
    """The lizard module, from this Python or from LIZARD_VENV; None when neither has it."""
    try:
        import lizard
    except ImportError:
        # lizard is pure Python, so a copy installed for another Python 3 version still imports.
        sys.path.extend(venv_site_packages())
        try:
            import lizard
        except ImportError:
            return None
    return lizard


def functions(path):
    """(name, length, ccn, params) per function; False for a language lizard
    does not read, None when lizard is missing."""
    lizard = import_lizard()
    if lizard is None:
        return None
    if lizard.get_reader_for(path) is None:
        return False
    full = os.path.join(ROOT, path)
    if path.endswith((".ts", ".tsx")):
        found = typescript_functions(lizard, full)
    else:
        found = lizard.analyze_file(full).function_list
    return [(f.name, f.end_line - f.start_line + 1, f.cyclomatic_complexity, param_count(path, f)) for f in found]


OPENERS, CLOSERS = "([{", ")]}"
# A slash after one of these, or at the start of a line, opens a regex literal.
# Not after "}" or "<": in JSX those come before the slash of a closing tag.
REGEX_AFTER = "(,=:[!&|?{;+-*%~^"
# Modes that end with their line: strings, and regex literals ("/", "/[" in a class).
LINE_MODES = ("'", '"', "/", "/[")


def _scan_code(line, at):
    """One step through code from index `at`: (next index, the mode that
    starts there: "block", a quote, "/" for a regex literal, or None)."""
    pair = line[at:at + 2]
    if pair == "//":
        return len(line), None
    if pair == "/*":
        return at + 2, "block"
    if line[at] in "'\"`":
        return at + 1, line[at]
    before = line[:at].rstrip()
    if line[at] == "/" and (not before or before[-1] in REGEX_AFTER or before.endswith("return")):
        return at + 1, "/"
    return at + 1, None


def _scan_literal(line, at, mode):
    """One step inside a comment, string or regex literal: (next index, mode)."""
    c = line[at]
    if mode == "block":
        return (at + 2, "code") if line[at:at + 2] == "*/" else (at + 1, mode)
    if c == "\\":
        return at + 2, mode
    if mode in ("/", "/["):
        if c == "[" or c == "]":
            return at + 1, "/[" if c == "[" else "/"
        return at + 1, "code" if mode == "/" and c == "/" else mode
    return at + 1, "code" if c == mode else mode


def _scan_line(line, state):
    """Carries the scan through one line. `state` is [depth, mode, templates]:
    bracket depth in code, the mode the line ends in ("code", "block" or "`")
    and the depths where each open template's `${` returns."""
    depth, mode, templates = state
    i = 0
    while i < len(line):
        c = line[i]
        if mode == "`" and line[i:i + 2] == "${":
            templates.append(depth)
            depth, mode, i = depth + 1, "code", i + 2
        elif mode != "code":
            i, mode = _scan_literal(line, i, mode)
        elif c == "}" and templates and depth - 1 == templates[-1]:
            depth, mode, i = templates.pop(), "`", i + 1
        else:
            depth += (c in OPENERS) - (c in CLOSERS)
            i, opened = _scan_code(line, i)
            mode = opened or mode
    state[:] = [depth, "code" if mode in LINE_MODES else mode, templates]


def top_level_starts(text):
    """Lines that begin a top-level statement: column 0, not a closing
    bracket, at bracket depth 0 and outside strings, templates and comments.
    None when the brackets do not add up, so the file is read whole."""
    state, starts = [0, "code", []], []
    for i, line in enumerate(text.splitlines(keepends=True)):
        if state[:2] == [0, "code"] and line[:1] not in ("", " ", "\t", "\r", "\n", *CLOSERS):
            starts.append(i)
        _scan_line(line, state)
        if state[0] < 0:
            return None
    return starts


def top_level_chunks(text):
    """The text cut before every top-level statement. Blank lines stand in for
    the lines before each piece, so line numbers hold."""
    lines = text.splitlines(keepends=True)
    starts = top_level_starts(text) or []
    bounds = [0] + [i for i in starts if i > 0] + [len(lines)]
    return ["\n" * a + "".join(lines[a:b]) for a, b in zip(bounds, bounds[1:]) if b > a]


def typescript_functions(lizard, full):
    # lizard loses its place in TypeScript after some type shapes, such as an
    # object type inside a generic (Promise<{ a: string }>), and folds the
    # functions after it into one. Reading each top-level statement on its own
    # keeps a misread inside that statement.
    # As lizard reads a file: a byte that is not UTF-8 never stops the check, and a BOM is dropped.
    with open(full, encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    return [fn for chunk in top_level_chunks(text)
            for fn in lizard.analyze_file.analyze_source_code(full, chunk).function_list]


def param_count(path, f):
    # lizard's own count, the one its -a limit uses. It includes a Python
    # method's self or cls, which the caller never passes.
    names = f.parameters
    if path.endswith(".py") and names and names[0] in ("self", "cls"):
        return f.parameter_count - 1
    return f.parameter_count


class Findings:
    def __init__(self):
        self.hard, self.soft, self.unread = [], [], set()
        self.lizard_missing = False

    def judge(self, path, construct, name, value, limits):
        if not limits:
            return
        soft, hard = limits
        if value > hard:
            self.hard.append((path, construct, name, value, hard))
        elif value > soft:
            self.soft.append((path, construct, name, value, soft))


def measure_file(found, path, shared, limits):
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return  # Tracked but deleted in the working tree.
    file_limits = limits["file"]
    if file_limits and is_test(path):
        file_limits = tuple(int(n * TEST_FILE_FACTOR) for n in file_limits)
    found.judge(path, "file", "-", len(lines), file_limits)
    if limits["line"]:
        # The value is how many lines run past the limit, so fixing some shows.
        soft, hard = limits["line"]
        over_hard = sum(1 for line in lines if len(line) > hard)
        over_soft = sum(1 for line in lines if len(line) > soft)
        if over_hard:
            found.hard.append((path, "line_length", "-", over_hard, hard))
        elif over_soft:
            found.soft.append((path, "line_length", "-", over_soft, soft))
    funcs = functions(path)
    if funcs is None:
        found.lizard_missing = True
        return
    if funcs is False:
        found.unread.add(os.path.splitext(path)[1])
        return
    for name, length, ccn, params in funcs:
        found.judge(path, "function", name, length, limits["function"])
        found.judge(path, "ccn", name, ccn, shared.get("ccn"))
        found.judge(path, "params", name, params, shared.get("params"))


def ledger_fields(line, reason):
    """(path, construct, name), last field. A reason may hold "|", so it takes
    the rest of the line; a baseline value is digits only, so the name takes
    everything before it, and a name holding "|" (a C++ operator|) reads back."""
    if reason:
        fields = [p.strip() for p in line.split("|", 3)]
        return (tuple(fields[:3]), fields[3]) if len(fields) == 4 else None
    head, _, value = line.rpartition("|")
    fields = [p.strip() for p in head.split("|", 2)]
    return (tuple(fields), value.strip()) if len(fields) == 3 else None


def load_ledger(path, reason=False):
    entries = {}
    if not os.path.exists(path):
        return entries
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            parsed = ledger_fields(line, reason) if line and not line.startswith("#") else None
            if parsed:
                # A list per key: one file can hold several same-named functions.
                entries.setdefault(parsed[0], []).append(parsed[1])
    return entries


def leftovers(hard, baseline):
    """Baseline keys that list more breaches than the tree still has: a line
    left after its code complied would excuse the next breach of that name."""
    current = {}
    for item in hard:
        current[item[:3]] = current.get(item[:3], 0) + 1
    return [(key, len(values), current.get(key, 0))
            for key, values in sorted(baseline.items()) if len(values) > current.get(key, 0)]


def write_baseline(hard):
    os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
    with open(BASELINE, "w", encoding="utf-8", newline="\n") as f:
        f.write("# Hard size breaches the project had when this was written. One that is\n")
        f.write("# not listed, or whose value grew past the listed one, fails the check.\n")
        f.write("# Delete a line once its code complies. Rewrite with --write-baseline.\n")
        f.write("# path|construct|name|value\n")
        for path, construct, name, value, _ in sorted(hard):
            f.write(f"{path}|{construct}|{name}|{value}\n")
    print(f"baseline written: {len(hard)} hard breaches recorded")


def compare(hard, baseline):
    """Breaches that share a key (several `(anonymous)` callbacks in one file,
    say) pair up with the recorded ones largest to largest; any beyond the
    recorded count are new."""
    by_key = {}
    for item in hard:
        by_key.setdefault(item[:3], []).append(item)
    new, grown, tolerated = [], [], []
    for key, items in by_key.items():
        # A value that is not a number allows nothing, so its breach fails.
        recorded = sorted((int(v) if v.isdigit() else -1 for v in baseline.get(key, [])), reverse=True)
        for i, item in enumerate(sorted(items, key=lambda it: it[3], reverse=True)):
            if i >= len(recorded):
                new.append(item)
            elif item[3] > recorded[i]:
                grown.append(item + (recorded[i],))
            else:
                tolerated.append(item)
    return new, grown, tolerated


def report(found, problems, compared, verbose):
    new, grown, tolerated = compared
    failed = bool(found.lizard_missing or problems or new or grown)
    if found.lizard_missing:
        print("SIZE_CHECK_DEGRADED: lizard is not installed, so no function rows ran (pip install lizard)")
    for problem in problems:
        print(problem)
    for path, construct, name, value, limit in new:
        print(f"SIZE_BREACH_NEW: {path}: {construct} {name} = {value} (hard limit {limit}); "
              "shrink it, or record a reason in .github/size-check/exceptions.txt")
    for path, construct, name, value, limit, base in grown:
        print(f"SIZE_BREACH_GREW: {path}: {construct} {name} = {value} (baseline {base}); "
              "recorded breaches may only shrink")
    if verbose:
        for path, construct, name, value, _ in tolerated:
            print(f"baselined: {path}: {construct} {name} = {value}")
        for path, construct, name, value, limit in sorted(found.soft):
            print(f"soft: {path}: {construct} {name} = {value} (soft limit {limit})")
        for ext in sorted(found.unread):
            print(f"note: lizard reads no functions from {ext} files; only their file and line rows ran")
    if not failed:
        print(f"size check clean ({len(tolerated)} recorded breaches tolerated, {len(found.soft)} soft; see --report)")
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Code-size check with a ratchet")
    ap.add_argument("--write-baseline", action="store_true", help="record today's hard breaches")
    ap.add_argument("--report", action="store_true", help="also list tolerated and soft findings")
    args = ap.parse_args(argv)

    with open(RULE, encoding="utf-8") as f:
        shared, by_ext, notes = read_rule(f.read())
    for note in notes:
        print(f"note: {note}")
    if not by_ext:
        # A clean result would only mean nothing was measured.
        print("SIZE_RULE_EMPTY: .claude/rules/code-size.md gives limits for no file type")
        return 1
    files = tracked_files(by_ext)
    found = Findings()
    for path in files:
        measure_file(found, path, shared, by_ext[os.path.splitext(path)[1]])

    exceptions = load_ledger(EXCEPTIONS, reason=True)
    hard = [h for h in found.hard if h[:3] not in exceptions and (h[0], h[1], "*") not in exceptions]
    if args.write_baseline:
        if found.lizard_missing:
            print("refusing to write a baseline without lizard: "
                  "it would leave out every function row (pip install lizard)")
            return 1
        write_baseline(hard)
        return 0

    baseline = load_ledger(BASELINE)
    tracked = set(files)
    problems = [f"SIZE_LEDGER_STALE: {'|'.join(k)} names a file that is no longer tracked"
                for k in list(exceptions) + list(baseline) if k[0] not in tracked]
    problems += [f"SIZE_LEDGER_LEFTOVER: {'|'.join(key)} is listed {listed} times in the baseline but breaches "
                 f"{now} times; delete the lines whose code now complies"
                 for key, listed, now in leftovers(hard, baseline) if key[0] in tracked]
    return report(found, problems, compare(hard, baseline), args.report)


if __name__ == "__main__":
    sys.exit(main())
