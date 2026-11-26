#!/usr/bin/env bash
# Approve staged npm versions in dependency order, waiting out npm's
# automated review (E409) between attempts instead of babysitting it.
#
# Usage: scripts/approve-staged.sh <stage-id> [<stage-id> ...]
# Pass the ids in dependency order: shared first, then its dependents.
# The approval itself is interactive (npm's browser auth + 2FA) — that is
# the human gate, and it stays human.
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 <stage-id> [<stage-id> ...]" >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

for id in "$@"; do
  attempt=0
  while :; do
    # tee keeps npm's auth prompt visible while we inspect the result.
    if npm stage approve "$id" 2>&1 | tee "$tmp"; then
      break
    fi
    if grep -q "E409" "$tmp"; then
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 10 ]; then
        echo "giving up on $id after $attempt attempts" >&2
        exit 1
      fi
      echo "automated review still running for $id — retrying in 60s" >&2
      sleep 60
    else
      # Any other failure (auth, revoked stage, network) stops the run:
      # later packages depend on this one landing.
      exit 1
    fi
  done
done
