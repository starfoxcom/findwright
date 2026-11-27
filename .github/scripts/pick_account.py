"""Picks the account a review runs on, from the account tokens the job has.
Standard library, Python 3.8+. The review workflows run the copy from the gate's
commit, so a PR cannot change how its own review picks an account.

    pick_account.py CLI MODEL [--ceiling N] [--output FILE]
        -> one ::notice:: line per account it moves past, then index=I, the
           number of the account to use (1 for CLAUDE_CODE_OAUTH_TOKEN, 2 to 5
           for CLAUDE_CODE_OAUTH_TOKEN_2 to _5), written to FILE as well; with
           no token set (the API key pays), no index at all

The tokens come in TOKEN_1 to TOKEN_5. Each set one, in order, gets a one-line
request on MODEL through the Claude Code CLI at CLI, run in an empty folder that
is its home and config folder, with only that account's token in its
environment. The first account that answers, and whose plan use in every window
the answer reports is under N percent, is picked. An account with no room, or
whose token the API refuses, is passed over; any other failure (a network error,
a timeout) picks that account, so a blip never starts another plan's window.
When every account is at or past N, the one with the most room left is picked;
when none answers, the first that has a token. N is 100 when not given or not a
number from 1 to 100, so only a spent plan moves the review on.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ACCOUNTS = 5
PROMPT = "Reply with the single word OK."
PROBE_SECONDS = 120
# The same limit texts the deep review's failure class reads.
LIMIT = re.compile(
    r"rate_limit_error|usage limit|quota exceeded|resource_exhausted"
    r"|(hit|reached) your [^.]{0,40}limit|(5-hour|weekly|daily|session|opus|sonnet) limit",
    re.IGNORECASE,
)
SECRET_NAMES = {"ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"} | {"TOKEN_%d" % i for i in range(1, ACCOUNTS + 1)}


def ceiling_of(text):
    """The ceiling in percent: a whole number from 1 to 100, else 100."""
    try:
        value = int(str(text).strip())
    except ValueError:
        return 100
    return value if 1 <= value <= 100 else 100


def read_answer(stdout):
    """The result event and the highest plan use in percent (None when the
    answer reports none) from what `claude -p --output-format json --verbose`
    printed: an array of events, or the one result object a CLI without
    --verbose output prints."""
    try:
        data = json.loads(stdout)
    except ValueError:
        return {}, None
    events = data if isinstance(data, list) else [data]
    events = [e for e in events if isinstance(e, dict)]
    results = [e for e in events if e.get("type", "result") == "result"]
    used = None
    for event in events:
        info = event.get("rate_limit_info") if event.get("type") == "rate_limit_event" else None
        windows = info.get("unifiedWindows") if isinstance(info, dict) else None
        for window in (windows or {}).values() if isinstance(windows, dict) else ():
            share = window.get("utilization") if isinstance(window, dict) else None
            if isinstance(share, (int, float)) and not isinstance(share, bool):
                # Rounded, since 0.57 * 100 is 56.99999999999999 in binary floats.
                used = max(used or 0.0, round(share * 100, 6))
    return (results[-1] if results else {}), used


def verdict(status, result, used, ceiling):
    """"use", "past" (answered, at or past the ceiling), "full" (no room) or
    "refused" for one account's answer."""
    answered = status == 0 and result and not result.get("is_error") and result.get("subtype", "success") == "success"
    if answered:
        return "past" if used is not None and used >= ceiling else "use"
    text = result.get("result") if isinstance(result.get("result"), str) else ""
    api = result.get("api_error_status")
    if api == 429 or LIMIT.search(text):
        return "full"
    if api in (401, 403):
        return "refused"
    return "use"


def probe(cli, model, token):
    """Runs the one-line request on one account. Returns (exit status, stdout)."""
    env = {k: v for k, v in os.environ.items() if k not in SECRET_NAMES}
    # Under RUNNER_TEMP, which the runner empties after every job, so a step its
    # timeout stops leaves nothing behind.
    home = tempfile.mkdtemp(prefix="probe-", dir=os.environ.get("RUNNER_TEMP") or None)
    try:
        return _run_probe(cli, model, home, dict(
            env, HOME=home, USERPROFILE=home, CLAUDE_CONFIG_DIR=os.path.join(home, ".claude"),
            CLAUDE_CODE_OAUTH_TOKEN=token, DISABLE_AUTOUPDATER="1"))
    finally:
        # Best effort: a process the CLI leaves behind may still be writing
        # there, and a folder that will not go must not fail the pick.
        shutil.rmtree(home, ignore_errors=True)


def _run_probe(cli, model, home, env):
    """The request itself, run in `home` with `env`. Returns (exit status, stdout)."""
    args = [cli, "-p", PROMPT, "--setting-sources", "user", "--strict-mcp-config",
            "--permission-mode", "default", "--max-turns", "1", "--model", model,
            "--effort", "low", "--output-format", "json", "--verbose"]
    # The answer goes to a file, not a pipe: a process the CLI leaves behind
    # holding a pipe open would keep the wait going past the timeout.
    answer_path = os.path.join(home, "answer.json")
    try:
        with open(answer_path, "w", encoding="utf-8") as answer:
            done = subprocess.run(args, cwd=home, env=env, stdin=subprocess.DEVNULL,
                                  stdout=answer, stderr=subprocess.DEVNULL, timeout=PROBE_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    with open(answer_path, encoding="utf-8", errors="replace") as answer:
        return done.returncode, answer.read()


def pick(cli, model, ceiling, tokens, run_probe=probe):
    """(index, notices): the account to use and a line for each one passed over."""
    notices, room = [], {}
    for i in sorted(tokens):
        status, stdout = run_probe(cli, model, tokens[i])
        result, used = read_answer(stdout)
        outcome = verdict(status, result, used, ceiling)
        if outcome == "use":
            return i, notices
        if outcome == "refused":
            notices.append("Account %d refused its token (API status %s)" % (i, result.get("api_error_status")))
        elif outcome == "past":
            notices.append("Account %d is at %d%% of its plan, past the %d%% ceiling" % (i, used, ceiling))
            room[i] = used
        else:
            notices.append("Account %d has no room left (exit %d, API status %s)"
                           % (i, status, result.get("api_error_status")))
    if room:
        best = min(room, key=lambda i: (room[i], i))
        notices.append("Every account is past the ceiling: account %d has the most room left" % best)
        return best, notices
    first = min(tokens)
    notices.append("No account can take the review (each has no room or refused its token): "
                   "trying account %d, the first one with a token" % first)
    return first, notices


def _option(args, name):
    """The value after `name` in args, or None."""
    return args[args.index(name) + 1] if name in args[:-1] else None


def main(argv):
    if len(argv) < 2:
        print("Usage: see the top of .github/scripts/pick_account.py", file=sys.stderr)
        return 1
    cli, model, rest = argv[0], argv[1], argv[2:]
    tokens = {i: os.environ.get("TOKEN_%d" % i, "") for i in range(1, ACCOUNTS + 1)}
    tokens = {i: t for i, t in tokens.items() if t}
    if not tokens:
        # The API key pays, so there is no account to pick and no index.
        print("::notice::No account token is set: nothing to pick")
        return 0
    # One account leaves nothing to pick, so nothing is spent asking it.
    index, notices = (min(tokens), [])
    if len(tokens) > 1:
        index, notices = pick(cli, model, ceiling_of(_option(rest, "--ceiling") or ""), tokens)
    for line in notices:
        print("::notice::" + line)
    print("index=%d" % index)
    if _option(rest, "--output"):
        with open(_option(rest, "--output"), "a", encoding="utf-8") as fh:
            fh.write("index=%d\n" % index)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
