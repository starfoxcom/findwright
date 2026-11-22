#!/usr/bin/env bash
# Sets the Claude account tokens the review workflows run on, in one sweep:
# reads each account's token once, with the input hidden, and writes it as a
# secret into every repository named with --repo, or else every repository
# the signed-in GitHub account owns (with --orgs, also those of each
# organization it administers) whose default branch holds the routine
# review workflow.
# Account 1 is CLAUDE_CODE_OAUTH_TOKEN, account 2
# CLAUDE_CODE_OAUTH_TOKEN_2, and so on up to 5; the workflows try them in
# that order when an account has no room left.
#
# With --api-key it also reads an Anthropic API key and writes it as
# ANTHROPIC_API_KEY: the reviews then try the key's credits first, and with
# --accounts 0 the key is the only payer. A repository that still holds any
# account token (CLAUDE_CODE_OAUTH_TOKEN to _5) keeps the subscription for the
# attempts after the first, so remove each one there to run every attempt on
# the key.
#
# Get each token with `claude setup-token`, signed in to that account. Tokens
# reach gh on standard input, never on a command line. Secrets of accounts
# above --accounts stay as they are: `gh secret delete NAME -R OWNER/NAME`
# removes one.
#
# Needs the gh CLI, logged in with admin access to each repository.

set -euo pipefail

readonly TOKEN_SECRET="CLAUDE_CODE_OAUTH_TOKEN"
readonly KEY_SECRET="ANTHROPIC_API_KEY"
readonly WORKFLOW=".github/workflows/claude-code-review.yml"
readonly REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

ACCOUNTS=""
ORGS=0
WITH_KEY=0
REPOS=()
TOKENS=()
KEY=""

usage() {
  cat << 'EOF'
Usage: set-review-tokens.sh --accounts N [--api-key] [--orgs | --repo OWNER/NAME...]

  --accounts N         How many Claude accounts the reviews use, 0 to 5.
                       The script asks for each one's token, from
                       'claude setup-token' signed in to that account.
                       0 needs --api-key: the reviews run on the key alone.
  --api-key            Also ask for an Anthropic API key (from the Claude
                       Console) and set it as ANTHROPIC_API_KEY.
  --repo OWNER/NAME    A repository to set them in; repeat for more
                       (default: every repository you own whose default
                       branch holds .github/workflows/claude-code-review.yml).
  --orgs               Also sweep the repositories of each organization
                       you administer. Needs the read:org scope; any
                       failed lookup stops before anything is written.
EOF
}

die() {
  echo "error: $*" >&2
  exit 2
}

parse_args() {
  local repo
  while [ $# -gt 0 ]; do
    case "$1" in
      --accounts) ACCOUNTS=${2:?--accounts needs a number}; shift ;;
      --repo) REPOS+=("${2:?--repo needs OWNER/NAME}"); shift ;;
      --orgs) ORGS=1 ;;
      --api-key) WITH_KEY=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  [[ $ACCOUNTS =~ ^[0-5]$ ]] || die "--accounts takes a number from 0 to 5"
  [ "$ACCOUNTS" != 0 ] || [ "$WITH_KEY" = 1 ] \
    || die "--accounts 0 needs --api-key: with no account and no key the reviews cannot run"
  [ "$ORGS" = 0 ] || [ ${#REPOS[@]} -eq 0 ] || die "--orgs sweeps; it does not go with --repo"
  for repo in ${REPOS[@]+"${REPOS[@]}"}; do
    [[ $repo =~ $REPO_RE ]] || die "--repo takes OWNER/NAME: $repo"
  done
}

secret_name() {
  if [ "$1" = 1 ]; then echo "$TOKEN_SECRET"; else echo "${TOKEN_SECRET}_$1"; fi
}

# Only GitHub's "not found" means a repository holds no review; any other
# failure stops the sweep, so a passing outage never skips a repository.
# With --orgs, a repository an organization owns is swept when the user
# administers that organization. Listing them needs the read:org scope, so
# a failed lookup stops the sweep too, naming the scope and --repo.
find_repos() {
  local name names err org orgs
  names=$(gh repo list --limit 1000 --no-archived --source --json nameWithOwner --jq '.[].nameWithOwner') \
    || die "cannot list your repositories"
  [ "$ORGS" = 1 ] || orgs=""
  [ "$ORGS" = 0 ] || orgs=$(gh api --paginate user/memberships/orgs \
      --jq '.[] | select(.state == "active" and .role == "admin") | .organization.login' 2>&1) \
    || die "cannot list your organizations ($orgs). Without the read:org scope, run" \
      "'gh auth refresh -s read:org' and try again; or name the repositories with --repo."
  while IFS= read -r org; do
    [ -n "$org" ] || continue
    names+=$'\n'$(gh repo list "$org" --limit 1000 --no-archived --source --json nameWithOwner --jq '.[].nameWithOwner') \
      || die "cannot list the repositories of $org; authorize the token for it, or name repositories with --repo"
  done <<< "$orgs"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if err=$(gh api "repos/$name/contents/$WORKFLOW" --silent 2>&1); then
      REPOS+=("$name")
    elif [[ $err != *"HTTP 404"* ]]; then
      die "cannot read whether $name holds $WORKFLOW: $err"
    fi
  done <<< "$names"
  [ ${#REPOS[@]} -gt 0 ] || die "none of your repositories holds $WORKFLOW; name them with --repo"
}

read_tokens() {
  local i j token
  for ((i = 1; i <= ACCOUNTS; i++)); do
    printf "Account %s's token (input hidden): " "$i" >&2
    IFS= read -rs token \
      || die "no token for account $i: run this in a terminal of your own, where it can ask for each one"
    echo >&2
    [[ $token != sk-ant-api* ]] \
      || die "account $i: that is an API key, not an account token; --api-key asks for the key on its own"
    [[ $token =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] \
      || die "account $i: that is not a token from 'claude setup-token' (those start with sk-ant-)"
    for ((j = 0; j < ${#TOKENS[@]}; j++)); do
      [ "${TOKENS[j]}" != "$token" ] || die "accounts $((j + 1)) and $i got the same token"
    done
    TOKENS+=("$token")
  done
}

read_key() {
  [ "$WITH_KEY" = 1 ] || return 0
  printf "API key (input hidden): " >&2
  IFS= read -rs KEY \
    || die "no API key: run this in a terminal of your own, where it can ask for it"
  echo >&2
  [[ $KEY =~ ^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}$ ]] \
    || die "that is not an Anthropic API key (those start with sk-ant-api)"
}

# One secret into one repository, from standard input so the value never
# reaches a command line.
set_secret() {
  printf '%s' "$3" | gh secret set "$2" -R "$1" > /dev/null
}

write_secrets() {
  local repo i name failed=0 what
  what="$ACCOUNTS account(s)"
  [ "$WITH_KEY" = 0 ] || what+=" and the API key"
  for repo in "${REPOS[@]}"; do
    for ((i = 1; i <= ACCOUNTS; i++)); do
      name=$(secret_name "$i")
      if ! set_secret "$repo" "$name" "${TOKENS[i - 1]}"; then
        printf '  FAILED   %s: %s (setting a secret needs admin access)\n' "$repo" "$name"
        failed=1
        continue 2
      fi
    done
    if [ "$WITH_KEY" = 1 ] && ! set_secret "$repo" "$KEY_SECRET" "$KEY"; then
      printf '  FAILED   %s: %s (setting a secret needs admin access)\n' "$repo" "$KEY_SECRET"
      failed=1
      continue
    fi
    printf '  set      %s: %s\n' "$repo" "$what"
  done
  return "$failed"
}

main() {
  parse_args "$@"
  # Claude Code sets CLAUDECODE=1 in every shell it starts. The secrets are the
  # maintainer's, so an assistant never writes them, however it spells the call.
  [ "${CLAUDECODE:-}" != 1 ] \
    || die "this writes repository secrets, so it runs only in your own terminal, not from a Claude Code session"
  command -v gh > /dev/null || die "the gh CLI is not installed"
  [ ${#REPOS[@]} -gt 0 ] || find_repos
  echo "Repositories: ${REPOS[*]}" >&2
  read_tokens
  read_key
  write_secrets
}

main "$@"
