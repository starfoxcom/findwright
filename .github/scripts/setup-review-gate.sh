#!/usr/bin/env bash
# Sets up what the review gate needs on a GitHub repository: the
# needs-deep-review label, merge settings, a ruleset per protected branch
# that requires the "Review gate" check, the review token secret, and the
# Claude GitHub App. With --check it changes nothing: it reports every
# missing piece and exits 1 when any is missing.
#
# Needs the gh CLI, logged in with admin access to the repository. Run it
# from the repository folder, or pass --repo OWNER/NAME.

set -euo pipefail

# GitHub Actions: the app that reports the workflows' checks.
readonly ACTIONS_APP_ID=15368
readonly LABEL="needs-deep-review"
readonly TOKEN_SECRET="CLAUDE_CODE_OAUTH_TOKEN"
readonly KEY_SECRET="ANTHROPIC_API_KEY"
# Kept current only under `checks: two` in .github/review-gate.yml. Under
# `checks: one` nothing reports it, so a branch rule requiring it blocks
# every PR.
readonly OLD_DEEP_CHECK="Claude On-Demand"
readonly BRANCH_RE='^[A-Za-z0-9._/-]+$'
readonly CHECK_RE='^[A-Za-z0-9 ._,()/:+-]+$'

MODE=setup
REPO=""
BRANCHES=()
REQUIRED=("Review gate")
MERGE_STYLE=merge
APPROVALS=0
DEFAULT_BRANCH=""
GATE_CHECKS=one
GAPS=0

usage() {
  cat << 'EOF'
Usage: setup-review-gate.sh [--check] [options]

  --check              Report what is missing and change nothing. Exits 1
                       when anything is missing.
  --repo OWNER/NAME    The repository (default: the one in this folder).
  --branch NAME        A branch to protect; repeat for more (default: the
                       default branch, plus develop when it exists).
  --require NAME       Another check the branches require besides
                       "Review gate"; repeat for more.
  --merge-style STYLE  merge, squash or rebase (default: merge).
  --approvals N        Approvals a PR needs besides the gate, 0 to 9
                       (default: 0, for a single maintainer).
EOF
}

die() {
  echo "error: $*" >&2
  exit 2
}

ok() { printf '  ok       %s\n' "$*"; }
fixed() { printf '  set up   %s\n' "$*"; }
note() { printf '  note     %s\n' "$*"; }
missing() {
  printf '  MISSING  %s\n' "$*"
  GAPS=$((GAPS + 1))
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) MODE=check ;;
      --repo) REPO=${2:?--repo needs OWNER/NAME}; shift ;;
      --branch) BRANCHES+=("${2:?--branch needs a name}"); shift ;;
      --require) REQUIRED+=("${2:?--require needs a check name}"); shift ;;
      --merge-style) MERGE_STYLE=${2:?--merge-style needs a value}; shift ;;
      --approvals) APPROVALS=${2:?--approvals needs a number}; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  validate_args
}

# Names end up inside jq programs and JSON text, so anything that could
# break out of a quoted string is refused.
validate_args() {
  local name repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  case "$MERGE_STYLE" in
    merge | squash | rebase) ;;
    *) die "--merge-style takes merge, squash or rebase" ;;
  esac
  [[ $APPROVALS =~ ^[0-9]$ ]] || die "--approvals takes a number from 0 to 9"
  [[ -z $REPO || $REPO =~ $repo_re ]] || die "--repo takes OWNER/NAME"
  for name in ${BRANCHES[@]+"${BRANCHES[@]}"}; do
    [[ $name =~ $BRANCH_RE ]] || die "unsupported branch name: $name"
  done
  for name in "${REQUIRED[@]}"; do
    [[ $name =~ $CHECK_RE ]] || die "unsupported check name: $name"
  done
}

branch_exists() {
  gh api "repos/$REPO/branches/$1" --silent 2> /dev/null
}

preflight() {
  local admin
  command -v gh > /dev/null || die "the gh CLI is not installed"
  if [ -z "$REPO" ]; then
    REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) \
      || die "no GitHub repository here; pass --repo OWNER/NAME"
  fi
  admin=$(gh api "repos/$REPO" --jq .permissions.admin) || die "cannot read $REPO"
  [ "$admin" = true ] || die "$REPO: reading and changing its settings needs admin access"
  DEFAULT_BRANCH=$(gh api "repos/$REPO" --jq .default_branch)
  if [ ${#BRANCHES[@]} -eq 0 ]; then
    BRANCHES=("$DEFAULT_BRANCH")
    if [ "$DEFAULT_BRANCH" != develop ] && branch_exists develop; then
      BRANCHES+=(develop)
    fi
  fi
}

# The `checks` setting from the repository's .github/review-gate.yml on its
# default branch; "one" when the file or the line is absent.
read_gate_checks() {
  local text value
  text=$(gh api -H "Accept: application/vnd.github.raw" \
    "repos/$REPO/contents/.github/review-gate.yml" 2> /dev/null) || text=""
  value=$(sed -nE 's/^checks:[[:space:]]*(one|two)([[:space:]#].*)?$/\1/p' <<< "$text")
  GATE_CHECKS=${value:-one}
}

step_label() {
  if gh api "repos/$REPO/labels/$LABEL" --silent 2> /dev/null; then
    ok "label $LABEL"
  elif [ "$MODE" = check ]; then
    missing "label $LABEL (the workflow adds it to PRs that owe a deep review)"
  else
    gh label create "$LABEL" -R "$REPO" --color B60205 \
      --description "The routine review asked for a deep review" > /dev/null
    fixed "label $LABEL"
  fi
}

# allow_merge_commit, allow_squash_merge and allow_rebase_merge for the style.
merge_flags() {
  case "$MERGE_STYLE" in
    merge) echo "true false false" ;;
    squash) echo "false true false" ;;
    rebase) echo "false false true" ;;
  esac
}

step_merge() {
  local want have m s r what="merge settings: $MERGE_STYLE only, branch deleted on merge"
  want="$(merge_flags) true"
  have=$(gh api "repos/$REPO" --jq '[.allow_merge_commit, .allow_squash_merge,
    .allow_rebase_merge, .delete_branch_on_merge] | map(tostring) | join(" ")')
  if [ "$have" = "$want" ]; then
    ok "$what"
  elif [ "$MODE" = check ]; then
    missing "$what"
  else
    read -r m s r <<< "$(merge_flags)"
    gh api -X PATCH "repos/$REPO" -F allow_merge_commit="$m" -F allow_squash_merge="$s" \
      -F allow_rebase_merge="$r" -F delete_branch_on_merge=true --silent
    fixed "$what"
  fi
}

step_secrets() {
  local names
  names=$(gh secret list -R "$REPO" --json name --jq '.[].name')
  if grep -qxF "$TOKEN_SECRET" <<< "$names"; then
    ok "secret $TOKEN_SECRET"
  elif [ "$MODE" = setup ] && [ -t 0 ]; then
    echo "  Paste the token that 'claude setup-token' prints:"
    gh secret set "$TOKEN_SECRET" -R "$REPO"
    fixed "secret $TOKEN_SECRET"
  else
    missing "secret $TOKEN_SECRET (get it with 'claude setup-token', then" \
      "run: gh secret set $TOKEN_SECRET -R $REPO)"
  fi
  if grep -qxF "$KEY_SECRET" <<< "$names"; then
    ok "secret $KEY_SECRET (reviews try the API credits first)"
  else
    note "no $KEY_SECRET secret: reviews run on the subscription only (optional)"
  fi
}

# A personal account gives gh no way to list installed apps, so the proof
# is a comment the app posted here, or an organization installation.
step_app() {
  local seen
  seen=$(gh api "repos/$REPO/issues/comments?sort=created&direction=desc&per_page=100" \
    --jq '[.[] | select(.user.login == "claude[bot]")] | length')
  if [ "${seen:-0}" -gt 0 ]; then
    ok "Claude GitHub App (it has commented here)"
    return
  fi
  if [ "$(gh api "repos/$REPO" --jq .owner.type)" = Organization ] \
    && gh api "orgs/${REPO%%/*}/installations" --jq '.installations[].app_slug' \
      2> /dev/null | grep -qx claude; then
    ok "Claude GitHub App (installed on the organization)"
    return
  fi
  note "Claude GitHub App not confirmed: install it from https://github.com/apps/claude" \
    "for $REPO, or run /install-github-app in Claude Code"
}

# A jq filter that is true when a ruleset is active and names the branch.
# Only exact names count, not patterns such as refs/heads/release/*.
covers_filter() {
  local ref="refs/heads/$1" default=""
  [ "$1" = "$DEFAULT_BRANCH" ] && default=' or . == "~DEFAULT_BRANCH"'
  echo ".enforcement == \"active\" and .target == \"branch\"
    and ((.conditions.ref_name.include // []) | any(. == \"$ref\" or . == \"~ALL\"$default))
    and ((.conditions.ref_name.exclude // []) | index(\"$ref\") | not)"
}

# The repository's own rulesets that protect the branch, one id per line.
rulesets_for() {
  local id filter
  filter=$(covers_filter "$1")
  for id in $(gh api "repos/$REPO/rulesets?per_page=100" \
    --jq '.[] | select(.source_type == "Repository") | .id'); do
    if [ "$(gh api "repos/$REPO/rulesets/$id" --jq "$filter")" = true ]; then
      echo "$id"
    fi
  done
}

# What the branch's rulesets lack, one line per gap; nothing when covered.
branch_gaps() {
  local ids id rule name types="" checks="" bypass=0
  ids=$(rulesets_for "$1")
  if [ -z "$ids" ]; then
    echo "no active ruleset"
    return
  fi
  for id in $ids; do
    types+=" $(gh api "repos/$REPO/rulesets/$id" --jq '[.rules[].type] | join(" ")') "
    checks+=$(gh api "repos/$REPO/rulesets/$id" --jq '.rules[]
      | select(.type == "required_status_checks")
      | .parameters.required_status_checks[].context')$'\n'
    bypass=$((bypass + $(gh api "repos/$REPO/rulesets/$id" --jq '.bypass_actors | length')))
  done
  for rule in deletion non_fast_forward pull_request; do
    [[ $types == *" $rule "* ]] || echo "rule $rule"
  done
  for name in "${REQUIRED[@]}"; do
    grep -qxF "$name" <<< "$checks" || echo "required check \"$name\""
  done
  if [ "$GATE_CHECKS" = one ] && grep -qxF "$OLD_DEEP_CHECK" <<< "$checks"; then
    echo "drop required check \"$OLD_DEEP_CHECK\" (nothing reports it under checks: one)"
  fi
  [ "$bypass" -eq 0 ] || echo "no bypass actors (has $bypass)"
}

pr_rule() {
  echo "{\"type\": \"pull_request\", \"parameters\": {
    \"required_approving_review_count\": $APPROVALS, \"dismiss_stale_reviews_on_push\": true,
    \"require_code_owner_review\": false, \"require_last_push_approval\": false,
    \"required_review_thread_resolution\": false, \"allowed_merge_methods\": [\"$MERGE_STYLE\"]}}"
}

# The required checks as a JSON array, each reported by GitHub Actions.
checks_json() {
  local name sep="" out="["
  for name in "${REQUIRED[@]}"; do
    out+="$sep{\"context\": \"$name\", \"integration_id\": $ACTIONS_APP_ID}"
    sep=", "
  done
  echo "$out]"
}

new_ruleset() {
  cat << EOF
{"name": "$1-protection", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/heads/$1"], "exclude": []}},
 "bypass_actors": [],
 "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}, $(pr_rule),
   {"type": "required_status_checks", "parameters": {
     "strict_required_status_checks_policy": false,
     "required_status_checks": $(checks_json)}}]}
EOF
}

# A jq step that appends the rule ($2) when no rule of its type ($1) exists.
ensure_rule() {
  echo "(if any(.[]; .type == \"$1\") then . else . + [$2] end) |"
}

# A jq program that repairs a ruleset read from the API. "full" adds the
# missing rules and checks; "strip" only removes bypass actors and the old
# deep check, for the branch's other rulesets.
fix_filter() {
  local ensure="" add="[]" drop="." keep
  local no_checks='{"type": "required_status_checks", "parameters": {
    "strict_required_status_checks_policy": false, "required_status_checks": []}}'
  if [ "$1" = full ]; then
    ensure="$(ensure_rule deletion '{"type": "deletion"}')
      $(ensure_rule non_fast_forward '{"type": "non_fast_forward"}')
      $(ensure_rule pull_request "$(pr_rule)")
      $(ensure_rule required_status_checks "$no_checks")"
    add=$(checks_json)
  fi
  if [ "$GATE_CHECKS" = one ]; then
    drop="map(select(.context != \"$OLD_DEEP_CHECK\"))"
  fi
  # $have and $c are jq variables, not shell ones.
  # shellcheck disable=SC2016
  keep='. as $have | . + ['"$add"'[] | select(.context as $c | $have | all(.context != $c))]'
  echo "{name, target, enforcement, conditions, bypass_actors: [], rules: (.rules | $ensure
    map(if .type == \"required_status_checks\"
      then .parameters.required_status_checks |= ($drop | $keep) else . end))}"
}

apply_ruleset() {
  local ids id mode primary=""
  ids=$(rulesets_for "$1")
  if [ -z "$ids" ]; then
    new_ruleset "$1" | gh api -X POST "repos/$REPO/rulesets" --input - --silent
    return
  fi
  # The full repair goes to the ruleset that already requires checks, so the
  # branch's other rulesets keep to their own purpose.
  for id in $ids; do
    if [ "$(gh api "repos/$REPO/rulesets/$id" \
      --jq 'any(.rules[]; .type == "required_status_checks")')" = true ]; then
      primary=$id
      break
    fi
  done
  primary=${primary:-${ids%%$'\n'*}}
  for id in $ids; do
    mode="strip"
    if [ "$id" = "$primary" ]; then mode="full"; fi
    gh api "repos/$REPO/rulesets/$id" --jq "$(fix_filter "$mode")" \
      | gh api -X PUT "repos/$REPO/rulesets/$id" --input - --silent
  done
}

step_rulesets() {
  local branch gaps gap
  for branch in "${BRANCHES[@]}"; do
    gaps=$(branch_gaps "$branch")
    if [ -n "$gaps" ] && [ "$MODE" = setup ]; then
      apply_ruleset "$branch"
      gaps=$(branch_gaps "$branch")
      [ -n "$gaps" ] || { fixed "ruleset on $branch"; continue; }
    fi
    if [ -z "$gaps" ]; then
      ok "ruleset on $branch"
      continue
    fi
    while IFS= read -r gap; do
      missing "ruleset on $branch: $gap"
    done <<< "$gaps"
  done
}

main() {
  parse_args "$@"
  preflight
  read_gate_checks
  echo "Review gate on $REPO ($MODE)"
  step_label
  step_merge
  step_secrets
  step_app
  step_rulesets
  if [ "$GAPS" -gt 0 ]; then
    echo "$GAPS missing."
    exit 1
  fi
  echo "All set."
}

main "$@"
