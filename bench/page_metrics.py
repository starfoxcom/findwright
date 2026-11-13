"""Writes the landing page's numbers from a replay's results.

Usage: python page_metrics.py <results.jsonl> <tuned-on project> <out.json>

Counts only the searches whose files both tools could reach ("clean"), the
same set summarize4.py reports. FindWright's answer is the `v3` ranking, the
one the shipped `find` tool uses; the baseline is the code-search tool it
replaced (`ts` in the results), which the page leaves unnamed.
"""
import json
import os
import statistics
import sys
from datetime import date

# A project with fewer searches than this gets no row of its own: its rate would be noise.
MIN_PROJECT_SEARCHES = 10
# projects.local.json (git-ignored) may give each project a public "kind", such as "A game".
PROJECTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "projects.local.json")


def rate(rows, hit):
    return round(100 * sum(1 for r in rows if hit(r)) / max(1, len(rows)))


def tool_numbers(rows, key, bytes_key):
    return {
        "hitRate": rate(rows, lambda r: r[key]["hit"]),
        "medianMs": round(statistics.median(r[key]["ms"] for r in rows)),
        "medianBytes": round(statistics.median(r[bytes_key]["bytes"] for r in rows)),
    }


def summary(rows):
    return {
        "searches": len(rows),
        # v3 reorders v2's answer without changing its format, so v2 holds its size.
        "findwright": tool_numbers(rows, "v3", "v2"),
        "baseline": tool_numbers(rows, "ts", "ts"),
    }


def main(results_path, tuned_on, out_path):
    with open(results_path, encoding="utf8") as fh:
        rows = [json.loads(line) for line in fh]
    clean = [r for r in rows if r["reachable"]]
    with open(PROJECTS, encoding="utf8") as fh:
        kinds = {name: p.get("kind") for name, p in json.load(fh).items()}
    by_project = {}
    for r in clean:
        by_project.setdefault(r["project"], []).append(r)
    projects = sorted((p for p, rs in by_project.items() if len(rs) >= MIN_PROJECT_SEARCHES),
                      key=lambda p: -len(by_project[p]))
    metrics = {
        "measured": date.today().isoformat(),
        "all": summary(clean),
        "heldOut": summary([r for r in clean if r["project"] != tuned_on]),
        "questions": summary([r for r in clean if r["tool"] == "ts_context"]),
        "names": summary([r for r in clean if r["tool"] == "ts_search" and not r["literal"]]),
        "projects": [{"kind": kinds.get(p) or f"Project {i + 1}", **summary(by_project[p])}
                     for i, p in enumerate(projects)],
    }
    with open(out_path, "w", encoding="utf8", newline="\n") as fh:
        json.dump(metrics, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:4])
