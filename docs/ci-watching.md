# Watching CI without the ci-watch mod

`.claude/rules/token-efficiency.md` § Watching CI points here when the `ci-watch` mod is not loaded. Use the **Monitor tool** where it exists:

- One monitor per PR, timeout one hour, so a stuck check becomes a loud timeout instead of a silent wait.
- Inside it, poll `gh pr checks <pr> --json name,bucket` about every 60 seconds. Filter on the `bucket` field with `gh`'s own `--jq` (the standalone `jq` binary is missing on some shells, and an empty result looks exactly like "still running").
- Print each check as it settles and finish with an explicit "all checks settled" line.
- On a new push to the same PR, stop the old monitor and start a new one.

Monitor is missing on some cloud providers and when non-essential traffic is disabled. Without it, run this as one Bash call with `run_in_background` and act when it exits. It stops after about nine minutes; if checks are still pending, run it again.

```bash
sleep 45
for i in $(seq 8); do
  state=$(gh pr checks <pr> --json bucket --jq 'if length == 0 then "none" else ([.[] | select(.bucket == "pending")] | length | tostring) end')
  [ "$state" = "0" ] && break
  sleep 60
done
gh pr checks <pr> --json name,bucket --jq '.[] | "\(.name): \(.bucket)"'
```
