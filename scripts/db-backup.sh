#!/usr/bin/env bash
#
# dbSOS — daily encrypted emergency backup of the Postgres database (GH #189).
#
# Purpose is FAST RECOVERY (RTO in minutes), not just having a copy: if the
# database corrupts, restore.sh brings a healthy snapshot back quickly so
# production users aren't down for long. A separate, slower infrastructure-level
# backup exists out of this repo; this is the local fast net, not a replacement.
#
# Produces one encrypted custom-format dump per run: pg_dump -Fc (compressed,
# and — crucially — restorable in parallel with `pg_restore -j`, which is what
# keeps the RTO low) piped straight into AES-256 so the plaintext never touches
# disk. The archive is verified (`pg_restore -l`) before the run is declared a
# success, so a corrupt/truncated dump can't masquerade as a good backup.
#
# Runner requirements: pg_dump, pg_restore, openssl on PATH (i.e. a container/
# host with postgresql-client + openssl — NOT the bare postgres image, which
# ships no openssl). Connects to Postgres over the network via DATABASE_URL.
#
# Required env:
#   DATABASE_URL      postgres connection URI to dump.
#   DBSOS_KEY_FILE    path to the AES passphrase file. MUST live separately from
#                     the backups (a mounted secret), never inside DBSOS_DIR —
#                     an encrypted backup whose key sits next to it is not
#                     encrypted. A restored dump stays decryptable only with the
#                     MASTER_KEY keyring in force at restore time (GH #172).
# Optional env:
#   DBSOS_DIR              output dir for .dump.enc files (default: ./backups).
#   DBSOS_RETENTION_DAYS   delete encrypted dumps older than this (default: 7).
#   DBSOS_STATUS_FILE      where the run outcome is published, in Prometheus
#                          text format (default: $DBSOS_DIR/dbsos-status.prom).
#                          Point it at a node_exporter textfile-collector dir to
#                          have it scraped; see docs/OPERATIONS.md.
#
# Exit codes — the scheduler's contract (GH #208). A cron entry that only knows
# "non-zero" can still alert; these let it say WHAT broke:
#   0  backup written and verified
#   1  configuration/preflight error (missing env var, missing tool, unreadable
#      key, key stored next to the backups)
#   2  the dump or its encryption failed — nothing was published
#   3  the integrity check failed — the dump was written, found unreadable, and
#      discarded, which is the one case that needs a human before the next run
#
# Why a status file at all: a cron job's non-zero exit goes into the void, so
# backups can stop for weeks without anyone noticing — a verified backup that
# nobody monitors is not DR. This run publishes its own outcome, and crucially
# the timestamp of the last SUCCESSFUL one, which is the number an alert has to
# watch: a failing run is not the emergency, a stale last-success is.
set -euo pipefail

EXIT_CONFIG=1
EXIT_DUMP=2
EXIT_VERIFY=3

fail() { code="$1"; shift; echo "db-backup: $*" >&2; exit "$code"; }

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DBSOS_KEY_FILE:?DBSOS_KEY_FILE is required (path to the AES passphrase, stored separately from the backups)}"
DBSOS_DIR="${DBSOS_DIR:-./backups}"
DBSOS_RETENTION_DAYS="${DBSOS_RETENTION_DAYS:-7}"

command -v pg_dump    >/dev/null 2>&1 || fail "$EXIT_CONFIG" "pg_dump not found on PATH"
command -v pg_restore >/dev/null 2>&1 || fail "$EXIT_CONFIG" "pg_restore not found on PATH"
command -v openssl    >/dev/null 2>&1 || fail "$EXIT_CONFIG" "openssl not found on PATH"
[ -r "$DBSOS_KEY_FILE" ] || fail "$EXIT_CONFIG" "DBSOS_KEY_FILE ($DBSOS_KEY_FILE) is not readable"

# Guardrail: refuse to write backups into the same directory the key lives in,
# which would defeat the point of encrypting them.
key_dir="$(cd "$(dirname "$DBSOS_KEY_FILE")" && pwd)"
mkdir -p "$DBSOS_DIR"
out_dir="$(cd "$DBSOS_DIR" && pwd)"
[ "$key_dir" != "$out_dir" ] || fail "$EXIT_CONFIG" "DBSOS_KEY_FILE must not live inside DBSOS_DIR ($out_dir)"

status_file="${DBSOS_STATUS_FILE:-$out_dir/dbsos-status.prom}"

# Reads one sample back out of the status file a PREVIOUS run wrote. This is
# what lets a failed run carry the last success forward instead of erasing it:
# without it, "last good backup" would reset on every failure and an operator
# could not tell a one-hour outage from a three-week one.
previous_sample() {
  [ -r "$status_file" ] || { echo 0; return 0; }
  awk -v name="$1" '$1 == name { value = $2 } END { print (value == "" ? 0 : value) }' \
    "$status_file" 2>/dev/null || echo 0
}

success_ts="$(previous_sample cefiro_dbsos_last_success_timestamp_seconds)"
success_size="$(previous_sample cefiro_dbsos_last_success_size_bytes)"

# Written atomically (temp + rename), which the node_exporter textfile collector
# requires: a scrape landing mid-write must never read a half-file.
write_status() {
  status_tmp="$status_file.$$.tmp"
  {
    echo "# HELP cefiro_dbsos_last_run_timestamp_seconds When the last dbSOS run finished, successful or not."
    echo "# TYPE cefiro_dbsos_last_run_timestamp_seconds gauge"
    echo "cefiro_dbsos_last_run_timestamp_seconds $(date -u +%s)"
    echo "# HELP cefiro_dbsos_last_run_exit_code Exit code of the last dbSOS run (0 ok, 1 config, 2 dump, 3 integrity)."
    echo "# TYPE cefiro_dbsos_last_run_exit_code gauge"
    echo "cefiro_dbsos_last_run_exit_code $1"
    echo "# HELP cefiro_dbsos_last_success_timestamp_seconds When the last VERIFIED backup was published (0 = never)."
    echo "# TYPE cefiro_dbsos_last_success_timestamp_seconds gauge"
    echo "cefiro_dbsos_last_success_timestamp_seconds $success_ts"
    echo "# HELP cefiro_dbsos_last_success_size_bytes Size of the last verified backup, in bytes."
    echo "# TYPE cefiro_dbsos_last_success_size_bytes gauge"
    echo "cefiro_dbsos_last_success_size_bytes $success_size"
  } > "$status_tmp" 2>/dev/null && mv -f "$status_tmp" "$status_file" 2>/dev/null || {
    rm -f "$status_tmp" 2>/dev/null || true
    echo "db-backup: could not publish status to $status_file" >&2
  }
  return 0
}

# UTC, second-granularity, sortable. Not using Date-derived randomness — the
# timestamp is the only variable and it sorts lexicographically.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$out_dir/dbsos-$stamp.dump.enc"
tmp="$out_dir/.dbsos-$stamp.partial"

# One exit path for both jobs: drop the partial files AND publish the outcome,
# whichever way the script leaves — success, `fail`, or an unexpected error
# `set -e` aborts on. Publishing only on the happy path would leave exactly the
# silence this exists to remove. The captured code is re-raised at the end so
# the trap cannot mask the script's own result.
on_exit() {
  code=$?
  [ -z "$tmp" ] || rm -f "$tmp" "$tmp.verify" 2>/dev/null || true
  write_status "$code"
  exit "$code"
}
trap on_exit EXIT

echo "db-backup: dumping to $final"
# -Fc custom format: compressed + parallel-restorable. Encrypt streaming so the
# plaintext dump is never written to disk. pbkdf2 + salt so the passphrase file
# isn't used as a raw key. `if !` rather than bare `set -e` so the failure is
# reported under the documented exit code instead of pg_dump's own.
if ! pg_dump -Fc --no-owner --no-privileges "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$DBSOS_KEY_FILE" \
  > "$tmp"; then
  fail "$EXIT_DUMP" "pg_dump/openssl failed — nothing was published"
fi

# Verify BEFORE publishing: decrypt and let pg_restore parse the archive TOC.
# If this fails the dump is corrupt/truncated and must not be kept as if good.
# A custom-format (-Fc) archive is NOT seekable through a pipe, and pg_restore
# needs to seek to read the TOC — so decrypt to a temp file and list that,
# rather than piping into `pg_restore -l`.
echo "db-backup: verifying archive integrity"
verify="$tmp.verify"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$DBSOS_KEY_FILE" -in "$tmp" -out "$verify" 2>/dev/null \
   || ! pg_restore -l "$verify" >/dev/null 2>&1; then
  rm -f "$verify"
  fail "$EXIT_VERIFY" "integrity check failed (could not decrypt or read the archive) — dump discarded"
fi
rm -f "$verify"

mv "$tmp" "$final"
# Only now is there a backup to report: the status file's "last success" must
# mean a dump that exists AND verified, never one that merely got as far as
# being written.
success_ts="$(date -u +%s)"
success_size="$(wc -c < "$final" | tr -d ' ')"
size="$(du -h "$final" | cut -f1)"
echo "db-backup: OK $final ($size)"

# Retention: drop encrypted dumps older than the window. Only touches our own
# dbsos-*.dump.enc, never the key or anything else in the dir.
if [ "$DBSOS_RETENTION_DAYS" -gt 0 ]; then
  find "$out_dir" -maxdepth 1 -name 'dbsos-*.dump.enc' -type f \
    -mtime "+$DBSOS_RETENTION_DAYS" -print -delete \
    | sed 's/^/db-backup: pruned /' || true
fi
