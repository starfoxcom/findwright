import json, sys, collections, statistics as st
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf8")]
def report(label, rs):
    if not rs: return
    n = len(rs); th = sum(r["ts"]["hit"] for r in rs); oh = sum(r["ours"]["hit"] for r in rs)
    both = sum(r["ts"]["hit"] and r["ours"]["hit"] for r in rs)
    only_o = sum(r["ours"]["hit"] and not r["ts"]["hit"] for r in rs); only_t = sum(r["ts"]["hit"] and not r["ours"]["hit"] for r in rs)
    tms = st.median(r["ts"]["ms"] for r in rs); oms = st.median(r["ours"]["ms"] for r in rs)
    tb = st.median(r["ts"]["bytes"] for r in rs); ob = st.median(r["ours"]["bytes"] for r in rs)
    v3 = sum(r["v3"]["hit"] for r in rs); v3c = [r for r in rs if r["reachable"]]
    print(f"{label:30} v3 {100*v3/n:3.0f}%  clean n={len(v3c)} ts {100*sum(r['ts']['hit'] for r in v3c)/max(1,len(v3c)):3.0f}% v2 {100*sum(r['v2']['hit'] for r in v3c)/max(1,len(v3c)):3.0f}% v3 {100*sum(r['v3']['hit'] for r in v3c)/max(1,len(v3c)):3.0f}%")
    vh = sum(r["v2"]["hit"] for r in rs); v_only = sum(r["v2"]["hit"] and not r["ts"]["hit"] for r in rs); t_only = sum(r["ts"]["hit"] and not r["v2"]["hit"] for r in rs)
    vms = st.median(r["v2"]["ms"] for r in rs); vb = st.median(r["v2"]["bytes"] for r in rs)
    print(f"{label:30} n={n:3}  ts {100*th/n:3.0f}%  v1 {100*oh/n:3.0f}%  v2 {100*vh/n:3.0f}%  v2-only {v_only:3} ts-only {t_only:3}  ms ts {tms:.0f} v2 {vms:.0f}  bytes ts {tb:.0f} v2 {vb:.0f}")
    return
    print(f"{label:38} n={n:3}  tokensave {th:3} ({100*th/n:3.0f}%)  ours {oh:3} ({100*oh/n:3.0f}%)  only-ours {only_o:3} only-ts {only_t:3}  ms {tms:.0f}/{oms:.0f}  bytes {tb:.0f}/{ob:.0f}")
report("ALL", rows)
for key in ["project", "tool", "source"]:
    for v in sorted({r[key] for r in rows}):
        report(f"{key}={v}", [r for r in rows if r[key] == v])
report("literal", [r for r in rows if r["literal"]])
report("fell back (session grepped after)", [r for r in rows if r["fell_back"]])
print("tokensave errors:", sum(not r["ts"]["ok"] for r in rows))
