import json, sys
# usage: summarize4.py results.jsonl <project the weights were tuned on>
TUNE = sys.argv[2]
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf8")]
clean = [r for r in rows if r["reachable"]]
def rate(rs, f): return f"{100*sum(f(r) for r in rs)/max(1,len(rs)):3.0f}%"
for label, rs in [("all clean", clean), ("tuned on", [r for r in clean if r["project"] == TUNE]), ("held out", [r for r in clean if r["project"] != TUNE]),
                  ("questions", [r for r in clean if r["tool"] == "ts_context"]), ("names", [r for r in clean if r["tool"] == "ts_search" and not r["literal"]])]:
    hit = lambda r, w: r["v4"][str(w)] is not None and r["v4"][str(w)] <= r["k"]
    print(f"{label:18} n={len(rs):3} ts {rate(rs, lambda r: r['ts']['hit'])} v3 {rate(rs, lambda r: r['v3']['hit'])} " + " ".join(f"w{w} {rate(rs, lambda r, w=w: hit(r, w))}" for w in [0.5, 1, 2, 4]))
