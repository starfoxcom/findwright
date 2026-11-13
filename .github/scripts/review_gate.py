"""The review gate's logic, shared by the routine and deep review workflows so
the workflow files stay the same for every project. Standard library and the
runner's `gh`, Python 3.8+. The workflows run the copy from the base branch.

    review_gate.py triage FILES [--incomplete] [--file .github/review-gate.yml]
        -> {"review": true|false}
    review_gate.py verdict --since TS (--tier routine --marker RE | --tier deep)
        -> {"verdict": "pass"|"block"|"missing", "line": ...[, "recovered": ...]}
        (reads the PR's comments as `gh api --paginate` prints them, on stdin)
    review_gate.py gate --state STATE [--triage T] [--routine R] [--escalated] [--deep D] [--order O]
        -> {"status", "conclusion", "title", "summary", "state"} for the "Review gate" check
    review_gate.py upsert --repo OWNER/NAME --sha HEAD [facts as for gate] [--note TEXT]
        -> the same, after creating or updating the check on that commit (GH_TOKEN
           needs checks: write); --note is appended to the check's summary, and
           --order is required with --triage, --routine or --deep
    review_gate.py settings [--file .github/review-gate.yml] -> KEY=value lines
        (dots become underscores; runner_labels adds the runner as a JSON list)
    review_gate.py escalate FILES DIFF [--file .github/review-gate.yml]
        -> {"escalate": true|false, "paths": [...], "lines": [...]}, the
           project's own deep-review triggers met by the changed files (one
           per line in FILES) and the lines the diff in DIFF adds

The "Review gate" check carries its own state in its external_id, e.g.
"triage=reviewable;routine=pass;escalated=yes;deep=none;routine_by=0.0.0;deep_by=0.0.0"
(an empty one is the start state). Each review workflow reads it, sets the
facts it knows and writes back the result, so whichever finishes last has
every fact. T: reviewable|skip; R: pending|pass|block|missing|error;
D: none|pass|block|missing|error. --escalated only ever turns on: once a deep
review was asked for, it stays asked. A workflow that cannot tell a fact
leaves its option out, keeping the stored value.

The two workflows can write at the same moment, and a write carries the whole
state as its writer read it, so one can wipe the other's facts. Two rules make
that harmless:
  - Each tier's facts carry the --order of the step that wrote them,
    RUN.ATTEMPT.STEP (routine_by for triage and routine, deep_by for deep),
    compared as numbers, field by field. RUN is whatever makes the run that
    counts the newest within its tier: the routine workflow uses its run id,
    and the deep workflow uses the moment its review job started, in
    nanoseconds, since its newest run cancels the one in flight. The two tiers'
    stamps are never compared with each other. A write from an older run never
    replaces a newer run's facts, so a cancelled deep run cannot undo the run
    that replaced it.
  - After writing, upsert reads the check back twice, a few seconds apart, and
    writes again when its own facts are gone.

Every command prints one line; a bad argument prints {"error": ...} and exits 1.
"""

import fnmatch
import json
import re
import subprocess
import sys
import time

# Never reviewed: the review app refuses its token to a run whose copy of the
# review workflow differs from the default branch's, so a workflow-only PR has
# to pass as non-reviewable. Only that one workflow: claude.yml (the deep tier
# runs the default branch's copy), any other workflow, and a script or action
# kept under .github/workflows/ are reviewed like any other file. A .yaml twin
# would run as a separate workflow, so it is reviewed too.
NEVER = re.compile(r"^\.github/workflows/claude-code-review\.yml$")
# Skipped only when every other path is Markdown, an image or a font that is
# not always reviewed. Always reviewed, whatever the file type, in every
# project: .github/scripts/, where a file Python loads before the standard
# library could run in the gate; .github/review-guide.md, the project's part
# of both review prompts; and a .claude/ folder at any depth and any
# CLAUDE.md or CLAUDE.local.md, the instructions and skills both review tiers
# load (Claude Code reads a subfolder's when it reads files there). A project
# adds its own paths with `triage.always_review` in the gate settings. Matched
# in any case, as a case-insensitive checkout would place the file. Anything
# else gets a review: scripts, config, lockfiles, an SVG, which can carry
# script, and a .gitattributes or .lfsconfig.
SKIPPABLE = re.compile(r"\.(md|png|jpe?g|gif|webp|ico|ttf|otf|woff2?)$", re.I)
ALWAYS_REVIEWED = re.compile(r"^\.github/scripts/|^\.github/review-guide\.md$|(^|/)\.claude/"
                             r"|(^|/)CLAUDE(\.local)?\.md$", re.I)

# The files API stops at 3,000 entries: a listing that long may be cut short.
LISTING_CAP = 3000

GATE = "Review gate"
BOT = "claude[bot]"
# A deep verdict comment: the review action's finished tracking comment, or
# the comment the CLI run on the API credits posts under this heading.
DEEP_MARKER = re.compile(r"\A(\*\*Claude finished|## Deep review)")
# Bot comments that are never a routine verdict: the deep-review request and
# the review action's tracking comments ("Claude Code is working…" while it
# runs, "**Claude finished…**" or "**Claude encountered an error**" after),
# whose glyphs belong to other runs, and a deep review whose heading is
# written slightly off ("# Deep Review", "**Deep review**").
NOT_ROUTINE = re.compile(r"\A(@claude review this PR|\*\*Claude |Claude Code is working"
                         r"|[#*_\s]*deep review)", re.I)
GLYPHS = re.compile("🔴|🟢")
# A line that blocks wherever it sits. Each prefix reads a checkbox ("[ ]",
# "[x]") as one unit and any other non-letter as another, never both ways,
# so a long row of checkboxes cannot make the match backtrack.
# 1. A 🔴 after list, quote, table, heading or emphasis markup: "**🔴 …**",
#    "- 🔴 x", "1. 🔴 Blocking …". Prose naming a 🔴 keeps it in backticks.
RED_OPENER = re.compile(r"(?:\[[ xX]\]|(?!\[[ xX]\]|[`🔴🟢])[\W\d_])*🔴")
# 2. "Blocking" opening a line after the same markup, as written when the
#    glyph is dropped: "1. **Blocking** — …", "### Blocking issues", "_Blocking_".
BLOCKING = re.compile(r"(?:\[[ xX]\]|(?!\[[ xX]\]|[`🟢])[\W\d_])*(?:Blocking|BLOCKING)(?![^\W_])")
# 3. "Blocking" right after a short label: up to 30 characters (a
#    single-backtick code span counts as one; a longer backtick run ends
#    the label) ending in a colon, a dash or a 🔴. After a
#    colon any case counts ("**Verdict:** blocking"). After a dash or a 🔴,
#    "Blocking" and "BLOCKING" always count ("- `a.py:1` — Blocking: x"),
#    and a lower-case "blocking" counts unless a word or a code span
#    follows it, which makes it an adjective in prose ("Change 3 — blocking
#    output", "— blocking `wait()`"); "— blocking finding" and "— blocking
#    issue" still count. A hyphen right after a letter or digit joins a
#    word ("Non-blocking: none") and ends no label.
_AFTER_LABEL = r"(?:(?![`🟢])[\W\d_])*"
# A word or a code span after the lower-case word, other than "finding" or
# "issue", even behind emphasis or a bracket ("— blocking **I/O**",
# "— blocking (sync) writes").
_ADJECTIVE = r"\s+[*_(\[~]*(?!(?i:findings?|issues?)(?![^\W_]))(?:[^\W_]|`)"
LABEL = re.compile(r"(?:(?<![`\\])`[^`]+`(?!`)|[^`🔴🟢]){0,30}?"
                   r"(?:[:：]" + _AFTER_LABEL + r"(?i:Blocking)"
                   r"|(?:[—–−]|(?<![^\W_])[-‐‑]|🔴)" + _AFTER_LABEL
                   + r"(?:Blocking|BLOCKING|(?i:blocking)(?![^\W_])(?!" + _ADJECTIVE + r")))"
                   r"(?![^\W_])")
# The verdict is the last line, under the review action's footer. Only lines
# that say nothing are skipped: a rule line, or an optional rule then pieces
# joined by "·" or "•", each empty or one item after an optional "branch:":
# a job or branch link on GitHub, or a branch name in a code span (no space
# or other character git refuses in a branch name). A lone item needs a
# "branch:" or "[View job]" in front ("[View job](…) · Branch: [`b`](…)",
# "--- · `b`"). Any words on a trailing line make it the last line.
FOOTER_RULE = re.compile(r"(?:-{3,}|\*{3,}|_{3,})")
_BRANCH = r"[^`\s~^:?*\[\\\]🔴🟢]{1,200}"
FOOTER_ITEM = re.compile(r"(?:[Bb]ranch:?\s*)?(?:\[(?:View job|`?%s`?)\]\(https://github\.com/"
                         r"[\w.-]+/[\w.-]+/(?:tree|actions/runs)/[^\s)🔴🟢]*\)|`%s`)" % (_BRANCH, _BRANCH))
FOOTER_LONE = re.compile(r"[Bb]ranch|\[View job\]")


def _footer(line):
    rest = line.strip()
    rule = FOOTER_RULE.match(rest)
    if rule:
        rest = rest[rule.end():].strip()
    if not rest:
        return True
    parts = re.split("[·•]", rest)
    return (all(not p.strip() or FOOTER_ITEM.fullmatch(p.strip()) for p in parts)
            and (len(parts) > 1 or bool(FOOTER_LONE.match(rest))))
# A quoted line ("> 🟢 LGTM") is someone else's verdict, never this one.
VERDICT_LINE = re.compile(r"[\s#*_]*(?:🔴|🟢)")
VERDICTS = ("pass", "block", "missing", "error")
STATE_VALUES = {
    "triage": ("reviewable", "skip"),
    "routine": ("pending",) + VERDICTS,
    "escalated": ("no", "yes"),
    "deep": ("none",) + VERDICTS,
}
START_STATE = {"triage": "reviewable", "routine": "pending", "escalated": "no", "deep": "none",
               "routine_by": "0.0.0", "deep_by": "0.0.0"}
# The order field that stamps each tier's facts, and the form of an order.
OWNER = {"triage": "routine_by", "routine": "routine_by", "deep": "deep_by"}
ORDER = re.compile(r"[0-9]{1,20}\.[0-9]{1,4}\.[0-9]{1,2}")
# upsert reads its write back after each of these delays, and writes again
# when its facts are gone, at most WRITE_ROUNDS times in all.
SETTLE_SECONDS = (3, 10)
WRITE_ROUNDS = 3

DEFAULTS = {
    "checks": "one", "runner": "ubuntu-latest",
    "routine.model": "claude-fable-5-2", "routine.effort": "low", "routine.max_turns": "120",
    "routine.fallback_model": "claude-opus-5-5", "routine.fallback_effort": "high",
    "deep.model": "claude-fable-5-2", "deep.effort": "medium", "deep.max_turns": "120",
    "deep.fallback_model": "claude-opus-5-5", "deep.fallback_effort": "high",
    "fallback.model": "claude-opus-5-5", "fallback.effort": "high",
    "prescreen.dir": "", "prescreen.attribution": "on",
    "escalate.auto": "on", "escalate.paths": "", "escalate.patterns": "", "reviewer.allowed_tools": "",
    "triage.always_review": "",
}
SECTIONS = {k.split(".")[0] for k in DEFAULTS if "." in k}
# A tier's own backup, when its file leaves it out, follows the shared one.
TIER_FALLBACK = {"%s.fallback_%s" % (t, k): "fallback." + k for t in ("routine", "deep") for k in ("model", "effort")}
_LABEL = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
_GLOB = r"[A-Za-z0-9._/*?-]{1,200}"
_TOOL = r"(?:Bash\([^\"'`$\\(),\n]{1,200}\)|Read|Grep|Glob)"
CHECKS = {
    "checks": re.compile(r"one|two"),
    "runner": re.compile(r"%s(?:, *%s){0,7}" % (_LABEL, _LABEL)),
    "model": re.compile(r"[a-z0-9][a-z0-9.-]{0,63}"),
    "effort": re.compile(r"low|medium|high|xhigh|max"),
    "max_turns": re.compile(r"[1-9][0-9]{0,2}"),
    # A folder in the repo, relative, with no `..` part.
    # The first character is no `-`, so no tool reads the value as an option.
    "dir": re.compile(r"|(?!(?:.*/)?\.\.(?:/|$))[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}"),
    "paths": re.compile(r"|%s(?:, *%s){0,49}" % (_GLOB, _GLOB)),
    "always_review": re.compile(r"|%s(?:, *%s){0,49}" % (_GLOB, _GLOB)),
    # Any Python regex up to 500 characters; settings() also compiles it.
    "patterns": re.compile(r"[^\n]{0,500}"),
    "allowed_tools": re.compile(r"|%s(?:, *%s){0,19}" % (_TOOL, _TOOL)),
    "attribution": re.compile(r"on|off"),
    "auto": re.compile(r"on|off"),
}
CHECKS["fallback_model"], CHECKS["fallback_effort"] = CHECKS["model"], CHECKS["effort"]


class GateError(Exception):
    pass


def triage(paths, incomplete=False, always_review=""):
    """Whether a diff with these changed paths gets an AI review.
    `always_review` is the project's `triage.always_review` setting."""
    if incomplete or len(paths) >= LISTING_CAP:
        return True
    globs = _globs(always_review)
    return any(not NEVER.search(p) and (ALWAYS_REVIEWED.search(p) or _glob_match(p, globs)
                                        or not SKIPPABLE.search(p)) for p in paths)


def _globs(setting):
    return [g.strip().casefold() for g in setting.split(",") if g.strip()]


def _glob_match(path, globs):
    """A path setting's match: any case, `*` crosses folders, and a glob
    ending in `/` covers the folder."""
    return any(fnmatch.fnmatchcase(path.casefold(), g + "*" if g.endswith("/") else g) for g in globs)


def _comments(text):
    """Every comment in `gh api --paginate` output, which prints one JSON array per page."""
    decoder, out, i = json.JSONDecoder(), [], 0
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i == len(text):
            return out
        page, i = decoder.raw_decode(text, i)
        if not isinstance(page, list):
            raise GateError("the comments are not a JSON list")
        out.extend(page)


def _bot_bodies(text, since):
    return [c.get("body") or "" for c in _comments(text)
            if isinstance(c, dict) and (c.get("user") or {}).get("login") == BOT
            and (c.get("created_at") or "") >= since]


def _pick(bodies, tier, marker):
    """The newest comment of `tier`. A routine comment carries `marker`, its
    heading: a comment without one is never taken for the routine verdict,
    since deep runs and requests post glyphs into the same thread. It is never
    a deep comment, even one quoting the routine review, nor a request or
    tracking comment that names the heading."""
    if tier == "deep":
        found = [b for b in bodies if DEEP_MARKER.search(b)]
    else:
        found = [b for b in bodies if marker.search(b) and not DEEP_MARKER.search(b)
                 and not NOT_ROUTINE.search(b)]
    return found[-1] if found else None


def _line(body):
    """The verdict line: the last line under the action's footer, which must
    open with 🔴 or 🟢; any 🔴 on it blocks. A line that blocks wherever it
    sits (RED_OPENER, BLOCKING, LABEL) blocks whatever the verdict line says:
    a 🟢 after it ("once fixed, this is 🟢 LGTM", a "🟢 All clear on X"
    heading) must not pass it, and the glyph is what gets dropped. With any
    other last line, a 🔴 on the last line holding a glyph blocks; otherwise
    the verdict is missing: a bare "LGTM", or "Verdict = Blocking" under a
    "🟢 All clear on X" heading, never passes."""
    lines = body.splitlines()
    glyph = any("🔴" in l or "🟢" in l for l in lines)
    early = next(((l, how) for l in lines for how, rule in
                  (("red-over-glyph", RED_OPENER), ("word-over-glyph", BLOCKING), ("word-over-glyph", LABEL))
                  if rule.match(l)), None)
    while lines and _footer(lines[-1]):
        lines.pop()
    last = lines[-1].strip() if lines else ""
    if VERDICT_LINE.match(last) and "🔴" in last:
        return "block", last, "glyph"
    if early:
        line, how = early
        return "block", line.strip(), (how if glyph else "word")
    if VERDICT_LINE.match(last):
        return "pass", last, "glyph"
    # No verdict line, but the last line holding a glyph holds a 🔴 ("Verdict:
    # 🔴 the writer races", then a closing remark): a block, never a missing
    # verdict, which would start a second deep review that could bury it.
    marked = [l for l in lines if "🔴" in l or "🟢" in l]
    if marked and "🔴" in marked[-1]:
        return "block", marked[-1].strip(), "glyph"
    return "missing", "", ""


def verdict(text, since, tier, marker=None):
    """The verdict in the bot's newest comment of `tier` posted at or after
    `since`. A block read from a "Blocking" line rather than a 🔴 adds
    `recovered`."""
    body = _pick(_bot_bodies(text, since), tier, re.compile(marker, re.I) if marker else None)
    if body is None:
        return {"verdict": "missing", "line": ""}
    result, line, how = _line(body)
    out = {"verdict": result, "line": line}
    if how == "word":
        out["recovered"] = "no 🔴/🟢 line; a line opening with Blocking"
    elif how == "word-over-glyph":
        out["recovered"] = "a line opening with Blocking outranks the 🟢 line"
    elif how == "red-over-glyph":
        out["recovered"] = "a line opening with 🔴 outranks the later 🟢 line"
    return out


def _check(status, conclusion, title, summary):
    return {"status": status, "conclusion": conclusion, "title": title, "summary": summary}


FAILED = {
    "block": ("Blocked by the {} review", "The {} review found something to fix. Fix it on the PR branch and push."),
    "missing": ("No {} verdict", "The {} review finished without a 🟢 or 🔴 line. Re-run it."),
    "error": ("The {} review errored", "No {} review attempt ran to the end. Re-run it."),
}


def _failed(result, tier):
    title, summary = FAILED[result]
    return _check("completed", "failure", title.format(tier), summary.format(tier))


def decide(triage_result, routine=None, escalated=False, deep=None):
    """The "Review gate" check from everything known so far. Both review
    workflows call this with the same facts, so whichever finishes last
    writes the full answer. Fails closed: anything but a clean pass from
    every tier that ran, or was asked for, blocks the merge."""
    if deep not in (None, "pass"):
        return _failed(deep, "deep")
    if triage_result == "skip":
        if deep == "pass":
            return _check("completed", "success", "Deep review 🟢",
                          "The diff has no reviewable files and the deep review passed.")
        if escalated:
            return _check("in_progress", None, "Deep review in progress",
                          "A deep review was asked for on a diff with no reviewable files.")
        return _check("completed", "success", "No review needed", "The diff has no reviewable files.")
    if routine == "pending":
        return _check("in_progress", None, "Routine review in progress", "Waiting for the routine review's verdict.")
    if routine != "pass":
        return _failed(routine, "routine")
    if deep == "pass":
        return _check("completed", "success", "Routine and deep reviews 🟢", "Both review tiers passed.")
    if escalated:
        return _check("in_progress", None, "Deep review in progress",
                      "The routine review passed and asked for a deep review.")
    return _check("completed", "success", "Routine review 🟢",
                  "The routine review passed and asked for no deep review.")


def parse_state(text):
    """The gate state stored in the check's external_id; empty is the start state."""
    state = dict(START_STATE)
    for part in filter(None, text.split(";")):
        key, _, value = part.partition("=")
        if key in OWNER.values():
            ok = ORDER.fullmatch(value)
        else:
            ok = value in STATE_VALUES.get(key, ())
        if not ok:
            raise GateError("bad gate state: " + part)
        state[key] = value
    return state


def _order(text):
    return tuple(int(p) for p in text.split("."))


def gate(state_text, triage=None, routine=None, escalated=False, deep=None, order=None):
    """Set the facts this workflow knows on the stored state, then decide.
    With `order`, a tier's facts are set only when no newer run wrote them."""
    state = parse_state(state_text)
    if order is not None and not ORDER.fullmatch(order):
        raise GateError("--order must be RUN.ATTEMPT.STEP, three numbers")
    for key, value in (("triage", triage), ("routine", routine), ("deep", deep)):
        if value is None:
            continue
        _choice(value, STATE_VALUES[key], "--" + key)
        if order is not None:
            if _order(order) < _order(state[OWNER[key]]):
                continue
            state[OWNER[key]] = order
        state[key] = value
    if escalated:
        state["escalated"] = "yes"
    check = decide(state["triage"], state["routine"], state["escalated"] == "yes",
                   None if state["deep"] == "none" else state["deep"])
    check["state"] = ";".join("%s=%s" % (k, state[k]) for k in START_STATE)
    return check


def _gh(path, method="GET", body=None):
    cmd = ["gh", "api", path, "-X", method] + (["--input", "-"] if body is not None else [])
    r = subprocess.run(cmd, input=json.dumps(body).encode("utf-8") if body is not None else None,
                       capture_output=True)
    if r.returncode:
        raise GateError("gh api %s %s failed: %s" % (method, path, r.stderr.decode("utf-8", "replace").strip()))
    return json.loads(r.stdout.decode("utf-8") or "null")


def check_body(check, note=""):
    """The Checks API body for a gate decision."""
    body = {"status": check["status"], "external_id": check["state"],
            "output": {"title": check["title"], "summary": (check["summary"] + " " + note).strip()}}
    if check["conclusion"]:
        body["conclusion"] = check["conclusion"]
    return body


def _newest(repo, sha):
    runs = _gh("repos/%s/commits/%s/check-runs?check_name=Review%%20gate&per_page=100" % (repo, sha))
    mine = [r for r in runs.get("check_runs", []) if r.get("name") == GATE]
    return max(mine, key=lambda r: r["id"]) if mine else None


def _write(repo, sha, current, note, facts):
    check = gate((current or {}).get("external_id") or "", **facts)
    body = check_body(check, note)
    if current:
        _gh("repos/%s/check-runs/%d" % (repo, current["id"]), "PATCH", body)
    else:
        _gh("repos/%s/check-runs" % repo, "POST", dict(body, name=GATE, head_sha=sha))
    return check


def _holds(current, facts):
    """Whether the check still has this write's facts, or a newer run's
    facts for the same tier."""
    if current is None:
        return False
    state = parse_state(current.get("external_id") or "")
    if facts.get("escalated") and state["escalated"] != "yes":
        return False
    for key in OWNER:
        if facts.get(key) is None:
            continue
        stored, mine = _order(state[OWNER[key]]), _order(facts["order"])
        if stored < mine or (stored == mine and state[key] != facts[key]):
            return False
    return True


def upsert(repo, sha, note="", **facts):
    """Decide from the gate check's stored state plus `facts`, then write the
    result back to the check on `sha`, creating it on the first call. Reads
    it back, and writes again while another workflow's write wiped the facts."""
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise GateError("upsert needs --repo OWNER/NAME and a 40-character --sha")
    if facts.get("order") is None and any(facts.get(k) is not None for k in OWNER):
        raise GateError("upsert needs --order with --triage, --routine or --deep")
    check = _write(repo, sha, _newest(repo, sha), note, facts)
    for round_ in range(WRITE_ROUNDS):
        current = None
        for delay in SETTLE_SECONDS:
            time.sleep(delay)
            current = _newest(repo, sha)
            if not _holds(current, facts):
                break
        else:
            return check
        if round_ < WRITE_ROUNDS - 1:
            check = _write(repo, sha, current, note, facts)
    raise GateError("another workflow kept overwriting the Review gate; re-run this job")


def settings(text):
    """KEY=value pairs from review-gate.yml: top-level keys and one level of
    nesting, `#` comments. Unknown keys and bad values are errors, never ignored."""
    values, section, given = dict(DEFAULTS), None, set()
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        m = re.fullmatch(r"( *)([a-z_]+):\s*(.*)", line)
        if not m:
            raise GateError("review-gate.yml line %d: expected `key: value`" % n)
        indent, key, value = m.groups()
        if not indent and not value:
            if key not in SECTIONS:
                raise GateError("review-gate.yml line %d: %s needs a value" % (n, key) if key in DEFAULTS
                                else "review-gate.yml line %d: unknown section %s" % (n, key))
            section = key
            continue
        name = "%s.%s" % (section, key) if indent else key
        if indent and section is None:
            raise GateError("review-gate.yml line %d: indented key outside a section" % n)
        if name not in DEFAULTS:
            raise GateError("review-gate.yml line %d: unknown setting %s" % (n, name))
        value = value.strip()
        # One matching pair of outer quotes, never more: a regex may start or
        # end with a quote of its own.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif value[:1] in ("\"", "'"):
            # An opening quote with no partner: a `#` inside quotes cut the
            # value short, and keeping the rest would change its meaning.
            raise GateError("review-gate.yml line %d: unbalanced quote in %s (a `#` starts a comment)" % (n, name))
        if not CHECKS[name.split(".")[-1]].fullmatch(value) or not _compiles(name, value):
            raise GateError("review-gate.yml line %d: bad value for %s: %s" % (n, name, value))
        values[name] = value
        given.add(name)
        section = section if indent else None
    for name, shared in TIER_FALLBACK.items():
        if name not in given:
            values[name] = values[shared]
    return values


def _compiles(name, value):
    if name != "escalate.patterns":
        return True
    try:
        re.compile(value)
    except re.error:
        return False
    return True


HUNK = re.compile(r"@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@")


def added_lines(diff):
    """The lines a unified diff adds, read hunk by hunk with the counts in
    each `@@` header, so an added line that starts with `++` (`++i;`) is never
    taken for a `+++` file header."""
    added, old, new = [], 0, 0
    for line in diff.split("\n"):
        if old <= 0 and new <= 0:
            m = HUNK.match(line)
            if m:
                old, new = int(m.group(1) or 1), int(m.group(2) or 1)
            continue
        if line.startswith("+"):
            # One trailing CR is the file's CRLF ending, dropped so a
            # `$`-anchored pattern still matches; a CR inside the line stays.
            added.append(line[1:-1] if line.endswith("\r") else line[1:])
            new -= 1
        elif line.startswith("-"):
            old -= 1
        elif not line.startswith("\\"):
            old, new = old - 1, new - 1
    return added


def escalate(paths, added, values):
    """The project's own deep-review triggers from review-gate.yml: paths that
    match an `escalate.paths` glob (any case; `*` crosses folders, and a glob
    ending in `/` covers the folder), and added diff lines that
    `escalate.patterns` finds. Returns what matched, so the pre-screen can
    name it. Nothing matches while `escalate.auto` is off: the project then
    asks for every deep review by hand."""
    if values["escalate.auto"] == "off":
        return {"escalate": False, "paths": [], "lines": []}
    globs = _globs(values["escalate.paths"])
    pattern = re.compile(values["escalate.patterns"]) if values["escalate.patterns"] else None
    hits = [p for p in paths if _glob_match(p, globs)]
    lines = [line for line in added if pattern.search(line)] if pattern else []
    return {"escalate": bool(hits or lines), "paths": hits, "lines": lines[:20]}


def _option(args, name, default=None):
    if name not in args:
        return default
    i = args.index(name) + 1
    if i == len(args):
        raise GateError(name + " needs a value")
    return args[i]


def _choice(value, allowed, name):
    if value not in allowed:
        raise GateError("%s must be one of %s" % (name, ", ".join(allowed)))
    return value


def run(argv):
    cmd, args = (argv[0], argv[1:]) if argv else ("", [])
    if cmd == "triage" and args:
        with open(args[0], encoding="utf-8") as fh:
            paths = [l.strip() for l in fh if l.strip()]
        values = _settings_file(args[1:])
        return {"review": triage(paths, "--incomplete" in args, values["triage.always_review"])}
    if cmd == "verdict":
        since = _option(args, "--since")
        tier = _choice(_option(args, "--tier"), ("routine", "deep"), "--tier")
        marker = _option(args, "--marker")
        if not since or (tier == "routine") != bool(marker):
            raise GateError("verdict needs --since, and --marker exactly when --tier is routine")
        # Bytes, not text: the verdict emoji must not depend on the runner's locale.
        return verdict(sys.stdin.buffer.read().decode("utf-8"), since, tier, marker)
    if cmd in ("gate", "upsert"):
        facts = {"triage": _option(args, "--triage"), "routine": _option(args, "--routine"),
                 "escalated": "--escalated" in args, "deep": _option(args, "--deep"),
                 "order": _option(args, "--order")}
        if cmd == "upsert":
            return upsert(_option(args, "--repo", ""), _option(args, "--sha", ""), _option(args, "--note", ""), **facts)
        if "--state" not in args:
            raise GateError("gate needs --state (an empty one is the start state)")
        return gate(_option(args, "--state"), **facts)
    if cmd == "settings":
        return _settings_file(args)
    if cmd == "escalate" and len(args) >= 2:
        values = _settings_file(args[2:])
        # Names decode strictly, as for triage: a name that is not UTF-8 fails
        # the command (one error line) rather than its printing.
        with open(args[0], encoding="utf-8") as fh:
            paths = [p for p in fh.read().split("\n") if p]
        # newline="": a carriage return inside an added line must stay in it,
        # not split it into a line with no "+" that the hunk walk skips.
        with open(args[1], encoding="utf-8", errors="replace", newline="") as fh:
            added = added_lines(fh.read())
        return escalate(paths, added, values)
    raise GateError("Usage: see the top of .github/scripts/review_gate.py")


def _settings_file(args):
    path = _option(args, "--file", ".github/review-gate.yml")
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        text = ""
    return settings(text)


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        result = run(argv)
    except (GateError, OSError, ValueError) as e:
        print(json.dumps({"error": str(e)}))
        return 1
    if argv and argv[0] == "settings":
        labels = [label.strip() for label in result["runner"].split(",")]
        lines = ["%s=%s" % (k.replace(".", "_"), v) for k, v in result.items()]
        print("\n".join(lines + ["runner_labels=" + json.dumps(labels)]))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
