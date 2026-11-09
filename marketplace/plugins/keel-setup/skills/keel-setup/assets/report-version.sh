#!/usr/bin/env bash
# report-version.sh — tell keel-api that a repository's release pipeline has
# run on a version.
#
# keel's CLI reports a version the moment `keel create-version` tags it, from
# the machine that tagged it. This script is the second witness: it runs in the
# repository's own pipeline, after the checks on the tag, and reports the same
# version with the repository's CI credential. keel-api joins the two reports
# into one record and counts this one as the confirmation; a version the CLI
# reported and no pipeline confirmed is flagged pending confirmation.
#
# The canonical copy, and its tests, live in keel-api at scripts/ci/. Copy it
# verbatim into a repository as .github/scripts/report-version.sh — see
# "Auditoría de versiones" in keel-api's README for the workflow around it.
#
# Environment:
#   KEEL_API_URL      required  keel-api's base URL, such as https://keel.foundathyon.dev
#   KEEL_CI_TOKEN     required  the repository's CI credential, klc_…, from a secret
#   KEEL_STATUS       required  published when the checks on the tag passed, failed if not
#   KEEL_CHECKS       optional  the checks' result as the CI words it: success, failure…
#   KEEL_TAG          optional  the tag; by default the one that started the run
#   KEEL_COMMIT       optional  the commit the tag points at; by default git's answer
#   KEEL_PACKAGE      optional  the package; by default the repository's name
#   KEEL_ENVIRONMENT  optional  the environment the version is for
#   KEEL_ATTEMPTS     optional  how many times to try before giving up, 6 by default
#   KEEL_RETRY_DELAY  optional  seconds before the first retry, 5 by default; it
#                               doubles after each one, up to a minute
#   KEEL_DRY_RUN      optional  1 prints the event instead of sending it
#
# Everything else comes from GitHub Actions' own variables — GITHUB_REPOSITORY,
# GITHUB_REF_NAME, GITHUB_RUN_ID… — and from git, in the checked-out tag.
#
# Exit status: 0 once keel-api has the report, stored now or by an earlier try;
# 1 when it does not. Failing is deliberate: the job goes red, which is where
# somebody looks first, and keel-api flags the version as pending confirmation
# anyway. Re-running the job reports it again.
set -euo pipefail

say() { printf '%s\n' "$*"; }

# GitHub Actions turns this line into an error annotation on the run.
die() {
  printf '::error title=keel-api::%s\n' "$*"
  exit 1
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

for tool in curl jq git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed to report the version and is not installed"
done

# --- What is being reported -------------------------------------------------

api_url=${KEEL_API_URL:-}
[ -n "$api_url" ] || die "KEEL_API_URL is not set: set it to keel-api's base URL, such as https://keel.foundathyon.dev"
api_url=${api_url%/}

token=${KEEL_CI_TOKEN:-}
[ -n "$token" ] || die "KEEL_CI_TOKEN is not set: ask a keel administrator for a CI credential for ${GITHUB_REPOSITORY:-this repository} (admin → Versions → CI credentials) and store it as the repository secret KEEL_CI_TOKEN"
case $token in
  klc_*) ;;
  *) die "KEEL_CI_TOKEN is not a CI credential — those start with klc_. A personal keel token cannot report for a pipeline." ;;
esac

status=$(lower "${KEEL_STATUS:-}")
case $status in
  published | failed) ;;
  *) die "KEEL_STATUS must be published or failed, not '${KEEL_STATUS:-}'" ;;
esac

repository=$(lower "${GITHUB_REPOSITORY:-}")
[ -n "$repository" ] || die "GITHUB_REPOSITORY is not set: run this in GitHub Actions, or set it to owner/name"

tag=${KEEL_TAG:-}
if [ -z "$tag" ]; then
  case ${GITHUB_REF:-} in
    refs/tags/*) tag=${GITHUB_REF#refs/tags/} ;;
  esac
fi
[ -n "$tag" ] || die "there is no tag to report: run this on a tag push, or set KEEL_TAG"

# The version is the tag without its v, as keel-api stores it.
version=$tag
case $version in
  v* | V*) version=${version#?} ;;
esac

package=$(lower "${KEEL_PACKAGE:-${repository##*/}}")

# The commit the tag points at — the tag's own commit when git knows the tag,
# otherwise what is checked out, which on a tag push is the same commit.
commit=${KEEL_COMMIT:-}
if [ -z "$commit" ]; then
  commit=$(git rev-parse --verify --quiet "refs/tags/${tag}^{commit}" 2>/dev/null ||
    git rev-parse --verify --quiet "HEAD^{commit}" 2>/dev/null ||
    printf '%s' "${GITHUB_SHA:-}")
fi
commit=$(lower "$commit")
[ -n "$commit" ] || die "cannot tell which commit $tag is: check the repository out before this step"

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# The id both witnesses compute for this version: SHA-256 of repository,
# package, version and commit, lowercase, joined by line feeds. keel's CLI
# computes the same one from its side, and keel-api checks it.
correlation=$(printf '%s\n%s\n%s\n%s' "$repository" "$package" "$version" "$commit" | sha256_hex)

new_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())'
  else
    return 1
  fi
}

# One id for this report, kept for every try below: keel-api stores a report
# once however many times it arrives, which is what makes retrying safe. A job
# run again gets a new id, and is a new report of the same version.
event_id=$(new_uuid | tr '[:upper:]' '[:lower:]') || die "cannot generate an event id: no /proc, uuidgen or python3"
occurred_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

origin=ci
[ "${GITHUB_ACTIONS:-}" = true ] && origin=github_actions
server=${GITHUB_SERVER_URL:-https://github.com}
run_id=${GITHUB_RUN_ID:-$event_id}
run_url=""
[ -n "${GITHUB_RUN_ID:-}" ] && run_url="$server/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
tagged_at=$(git for-each-ref --format='%(creatordate:iso-strict)' "refs/tags/$tag" 2>/dev/null || true)
go_module=$(sed -n 's/^module[[:space:]][[:space:]]*//p' go.mod 2>/dev/null | head -n 1 | tr -d '\r' || true)

event=$(jq -n \
  --arg event_id "$event_id" \
  --arg correlation_id "$correlation" \
  --arg occurred_at "$occurred_at" \
  --arg repository "$repository" \
  --arg package "$package" \
  --arg version "$version" \
  --arg status "$status" \
  --arg commit_sha "$commit" \
  --arg environment "$(lower "${KEEL_ENVIRONMENT:-}")" \
  --arg origin "$origin" \
  --arg run_id "$run_id" \
  --arg ci_actor "${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}" \
  --arg tag "$tag" \
  --arg checks "${KEEL_CHECKS:-}" \
  --arg tagged_at "$tagged_at" \
  --arg go_module "$go_module" \
  --arg release_url "$server/${GITHUB_REPOSITORY:-$repository}/releases/tag/$tag" \
  --arg run_attempt "${GITHUB_RUN_ATTEMPT:-}" \
  --arg run_url "$run_url" \
  --arg workflow "${GITHUB_WORKFLOW:-}" \
  --arg job "${GITHUB_JOB:-}" \
  --arg trigger "${GITHUB_EVENT_NAME:-}" \
  --arg ref "${GITHUB_REF:-}" \
  '
  def present: with_entries(select(.value != "" and .value != null));
  {
    event_id: $event_id,
    type: "version.created",
    schema_version: 2,
    source: "ci",
    correlation_id: $correlation_id,
    occurred_at: $occurred_at,
    repository: $repository,
    package: $package,
    version: $version,
    status: $status,
    commit_sha: $commit_sha,
    environment: $environment,
    origin: $origin,
    run_id: $run_id,
    reported_actor: ({ci_actor: $ci_actor} | present),
    metadata: ({
      tag: $tag,
      checks: $checks,
      tagged_at: $tagged_at,
      go_module: $go_module,
      release_url: $release_url,
      ci: ({
        provider: $origin,
        run_id: $run_id,
        run_attempt: $run_attempt,
        run_url: $run_url,
        workflow: $workflow,
        job: $job,
        event: $trigger,
        ref: $ref
      } | present),
      reporter: {name: "report-version.sh", version: "1"}
    } | present)
  } | present')

if [ "${KEEL_DRY_RUN:-}" = 1 ]; then
  printf '%s\n' "$event" | jq .
  exit 0
fi

# --- Sending it ---------------------------------------------------------------

attempts=${KEEL_ATTEMPTS:-6}
delay=${KEEL_RETRY_DELAY:-5}
case $attempts in '' | *[!0-9]* | 0) die "KEEL_ATTEMPTS must be a whole number above zero, not '$attempts'" ;; esac
case $delay in '' | *[!0-9]*) die "KEEL_RETRY_DELAY must be a whole number of seconds, not '$delay'" ;; esac

body=$(mktemp)
answer=$(mktemp)
trap 'rm -f "$body" "$answer"' EXIT
printf '%s' "$event" >"$body"

url="$api_url/api/v1/audit/ci/events"
say "Reporting $repository $version ($status) to keel-api — event $event_id, correlation $correlation"

# What keel-api said, for the log: its message and scope when it sent one.
explain() {
  jq -r '[.error.message // .message // empty, (.error.scope // empty | "(" + . + ")")] | join(" ")' "$answer" 2>/dev/null || true
}

attempt=1
while :; do
  # The credential reaches curl on its standard input, as configuration, so it
  # is never an argument — and never in the process list or in the job's log.
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --silent --show-error --config - \
      --connect-timeout 10 --max-time 30 \
      --header 'Content-Type: application/json' \
      --header 'Accept: application/json' \
      --user-agent 'keel-report-version/1' \
      --data-binary "@$body" \
      --output "$answer" \
      --write-out '%{http_code}' \
      "$url") || code=000

  case $code in
    200 | 201)
      confirmation=$(jq -r '.data.version.confirmation // "recorded"' "$answer" 2>/dev/null || echo recorded)
      if [ "$code" = 200 ]; then
        say "keel-api already had this report (a retry of one that did arrive): $repository $version is $confirmation"
      else
        say "keel-api recorded $repository $version ($status): the version is $confirmation"
      fi
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        printf '### keel-api\n\n`%s` **%s** reported as `%s` — the version is **%s**.\n' \
          "$repository" "$version" "$status" "$confirmation" >>"$GITHUB_STEP_SUMMARY"
      fi
      exit 0
      ;;
    000) reason="keel-api could not be reached" ;;
    408 | 429 | 5??) reason="keel-api answered $code $(explain)" ;;
    401) die "keel-api refused the CI credential (401 $(explain)): it is wrong, revoked or expired. Issue a new one in keel's admin (Versions → CI credentials) and update the KEEL_CI_TOKEN secret." ;;
    404) die "$url answered 404: KEEL_API_URL is wrong, or that keel-api predates CI reporting" ;;
    *) die "keel-api refused the report ($code $(explain)). Sending it again would get the same answer." ;;
  esac

  if [ "$attempt" -ge "$attempts" ]; then
    die "gave up after $attempt attempts: $reason. Re-run the job to report the version again."
  fi
  say "Attempt $attempt of $attempts failed: $reason. Trying again in ${delay}s."
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  [ "$delay" -le 60 ] || delay=60
done
