#!/usr/bin/env bash
# Authored by Tomás Neto (TN 2026)
# Computes registry, image name, tags and OCI labels for the "Build & Push" workflows
# (Forgejo and GitHub). Writes step outputs in the $GITHUB_OUTPUT format to stdout.
#
# Inputs (env):
#   REGISTRY       vars.DOCKERHUB_URL         optional, default docker.io (scheme optional)
#   REPOSITORY     vars.DOCKERHUB_REPOSITORY  e.g. tnetomos/mail-gateway
#   INPUT_VERSION  workflow_dispatch input    bare semver, optional
#   RELEASE_TAGS   extra tags for every release (not pre-releases, not dev builds), space or
#                  comma separated, optional. The Forgejo workflow sets "prod".
#   GITHUB_REF / GITHUB_SHA / GITHUB_SERVER_URL / GITHUB_REPOSITORY   (set by the runner)
#
# Tags:  release 1.2.3        → 1.2.3, 1.2, latest, <RELEASE_TAGS>, sha-<commit>
#        pre-release 1.3.0-rc.1 → 1.3.0-rc.1, sha-<commit>
#        no version            → dev, sha-<commit>
# The migrations image gets the same tags with a "-migrate" suffix (same repository).
set -euo pipefail

reg="${REGISTRY:-docker.io}"
reg="${reg#https://}"; reg="${reg#http://}"; reg="${reg%/}"
repo="${REPOSITORY:-}"
if [ -z "$repo" ]; then echo "::error::Repository variable DOCKERHUB_REPOSITORY is not set (e.g. tnetomos/mail-gateway)" >&2; exit 1; fi
repo="${repo#/}"; repo="${repo%/}"
image="$(printf '%s/%s' "$reg" "$repo" | tr '[:upper:]' '[:lower:]')"

sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
short="${sha:0:12}"

version="${INPUT_VERSION:-}"
version="${version#v}"
if [ -z "$version" ] && [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then version="${GITHUB_REF#refs/tags/v}"; fi

tags=()
if [ -n "$version" ]; then
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "::error::version must be semver like 1.2.0 or 1.3.0-rc.1 (got '$version')" >&2; exit 1
  fi
  tags+=("$version")
  if [[ "$version" != *-* ]]; then
    tags+=("${version%.*}" "latest")
    for t in ${RELEASE_TAGS//,/ }; do
      if ! [[ "$t" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
        echo "::error::invalid tag '$t' in RELEASE_TAGS" >&2; exit 1
      fi
      tags+=("$t")
    done
  fi
else
  tags+=("dev")
fi
tags+=("sha-$short")

created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
source_url="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}"

echo "registry=$reg"
echo "image=$image"
echo "repository=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
echo "username=$(printf '%s' "${repo%%/*}" | tr '[:upper:]' '[:lower:]')"
echo "version=${version:-dev}"
echo "runtime_tags<<__TAGS__"
for t in "${tags[@]}"; do echo "$image:$t"; done
echo "__TAGS__"
echo "migrate_tags<<__TAGS__"
for t in "${tags[@]}"; do echo "$image:$t-migrate"; done
echo "__TAGS__"
echo "labels<<__LABELS__"
echo "org.opencontainers.image.title=mail-gateway"
echo "org.opencontainers.image.description=Mail-sending gateway with guardrails (API, worker, admin UI)"
echo "org.opencontainers.image.version=${version:-dev}"
echo "org.opencontainers.image.revision=$sha"
echo "org.opencontainers.image.created=$created"
echo "org.opencontainers.image.source=$source_url"
echo "__LABELS__"
