"""Harvests code searches from past session transcripts, each with the files the
session read or edited right after it (the ground truth for a replay).

Usage: python harvest.py <out.jsonl>
"""
import glob
import json
import os
import re
import sys

# projects.local.json (git-ignored): {"<name>": {"root": "<repo>", "transcripts": "<CLI project folder>"}}
PROJECTS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "projects.local.json"), encoding="utf8"))
TS = "mcp__tokensave__tokensave_"
SEARCH_TOOLS = {TS + "search", TS + "context", "Grep", "Glob"}
USE_TOOLS = {"Read": "file_path", "Edit": "file_path", "Write": "file_path",
             "MultiEdit": "file_path", TS + "read": "path"}
SHELL_SEARCH = re.compile(r"(^|[|;&]\s*)(git\s+grep|grep|rg|egrep)\s")
WINDOW = 8


def norm(path, root):
    """Repo-relative forward-slash path, or None when it lies outside the repo."""
    if not path:
        return None
    p = path.replace("\\", "/")
    if re.match(r"^/[a-zA-Z]/", p):
        p = p[1] + ":" + p[2:]
    r = root.lower().rstrip("/") + "/"
    if p.lower().startswith(r):
        return p[len(r):]
    if not re.match(r"^[a-zA-Z]:|^/", p):
        return p.lstrip("./")
    return None


def result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
    return (content or "")[:20000]


def calls(path):
    """The session's tool calls in order: (name, input, result text)."""
    seq, results = [], {}
    with open(path, encoding="utf8", errors="replace") as f:
        for line in f:
            if '"tool_use"' not in line and '"tool_result"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("isSidechain"):
                continue
            for block in (row.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if row.get("type") == "assistant" and block.get("type") == "tool_use":
                    seq.append((block.get("name"), block.get("input") or {}, block.get("id")))
                elif block.get("type") == "tool_result":
                    results[block.get("tool_use_id")] = result_text(block)
    return [(name, args, results.get(i, "")) for name, args, i in seq]


def is_search(name, args):
    if name in SEARCH_TOOLS:
        return True
    return name in ("Bash", "PowerShell") and bool(SHELL_SEARCH.search(args.get("command", "")))


def harvest(project, root, out):
    folder = os.path.expanduser(PROJECTS[project]["transcripts"])
    count = 0
    for transcript in sorted(glob.glob(folder + "/*.jsonl")):
        seq = calls(transcript)
        for i, (name, args, _) in enumerate(seq):
            if not is_search(name, args) or name in ("Bash", "PowerShell"):
                continue
            truth, fell_back, fb_text = [], False, ""
            for j in range(i + 1, min(i + 1 + WINDOW, len(seq))):
                nname, nargs, ntext = seq[j]
                if is_search(nname, nargs):
                    fell_back = name.startswith(TS) and not nname.startswith(TS) and j - i <= 3
                    fb_text = ntext if fell_back else ""
                    break
                key = USE_TOOLS.get(nname)
                rel = norm(nargs.get(key), root) if key else None
                if rel and rel not in truth:
                    truth.append(rel)
            out.write(json.dumps({"project": project, "session": os.path.basename(transcript)[:8],
                                  "tool": name.replace(TS, "ts_"), "input": args,
                                  "truth": truth, "fell_back": fell_back, "fb_text": fb_text}) + "\n")
            count += 1
    return count


def main():
    with open(sys.argv[1], "w", encoding="utf8") as out:
        for project, spec in PROJECTS.items():
            print(project, harvest(project, spec["root"], out), flush=True)


main()
