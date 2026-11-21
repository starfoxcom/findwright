#!/usr/bin/env bash
# Sets the Claude account tokens the review workflows run on, in one sweep:
# reads each account's token once, with the input hidden, and writes it as a
# secret into every repository named with --repo, or else every repository
# the signed-in GitHub account owns whose default branch holds the routine
# review workflow. Account 1 is CLAUDE_CODE_OAUTH_TOKEN, account 2
# CLAUDE_CODE_OAUTH_TOKEN_2, and so on up to 5; the workflows try them in
# that order when an account has no room left.
#
# Get each token with `claude setup-token`, signed in to that account. Tokens
# reach gh on standard input, never on a command line. Secrets of accounts
# above --accounts stay as they are: `gh secret delete NAME -R OWNER/NAME`
# removes one.
#
# Needs the gh CLI, logged in with admin access to each repository.

set -euo pipefail

readonly TOKEN_SECRET="CLAUDE_CODE_OAUTH_TOKEN"
readonly WORKFLOW=".github/workflows/claude-code-review.yml"
readonly REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

ACCOUNTS=""
REPOS=()
TOKENS=()

usage() {
  cat << 'EOF'
Usage: set-review-tokens.sh --accounts N [--repo OWNER/NAME]...

  --accounts N         How many Claude accounts the reviews use, 1 to 5.
                       The script asks for each one's token, from
                       'claude setup-token' signed in to that account.
  --repo OWNER/NAME    A repository to set them in; repeat for more
                       (default: every repository you own whose default
                       branch holds .github/workflows/claude-code-review.yml).
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
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  [[ $ACCOUNTS =~ ^[1-5]$ ]] || die "--accounts takes a number from 1 to 5"
  for repo in ${REPOS[@]+"${REPOS[@]}"}; do
    [[ $repo =~ $REPO_RE ]] || die "--repo takes OWNER/NAME: $repo"
  done
}

secret_name() {
  if [ "$1" = 1 ]; then echo "$TOKEN_SECRET"; else echo "${TOKEN_SECRET}_$1"; fi
}

# Only GitHub's "not found" means a repository holds no review; any other
# failure stops the sweep, so a passing outage never skips a repository.
find_repos() {
  local name names err
  names=$(gh repo list --limit 1000 --no-archived --source --json nameWithOwner --jq '.[].nameWithOwner') \
    || die "cannot list your repositories"
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
    [[ $token =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] \
      || die "account $i: that is not a token from 'claude setup-token' (those start with sk-ant-)"
    for ((j = 0; j < ${#TOKENS[@]}; j++)); do
      [ "${TOKENS[j]}" != "$token" ] || die "accounts $((j + 1)) and $i got the same token"
    done
    TOKENS+=("$token")
  done
}

write_secrets() {
  local repo i name failed=0
  for repo in "${REPOS[@]}"; do
    for ((i = 1; i <= ACCOUNTS; i++)); do
      name=$(secret_name "$i")
      if ! printf '%s' "${TOKENS[i - 1]}" | gh secret set "$name" -R "$repo" > /dev/null; then
        printf '  FAILED   %s: %s (setting a secret needs admin access)\n' "$repo" "$name"
        failed=1
        continue 2
      fi
    done
    printf '  set      %s: %s account(s)\n' "$repo" "$ACCOUNTS"
  done
  return "$failed"
}

main() {
  parse_args "$@"
  command -v gh > /dev/null || die "the gh CLI is not installed"
  [ ${#REPOS[@]} -gt 0 ] || find_repos
  echo "Repositories: ${REPOS[*]}" >&2
  read_tokens
  write_secrets
}

main "$@"
