#!/usr/bin/env bash
#
# dbSOS — restore an encrypted emergency backup (GH #189).
#
# The fast half of the recovery story: decrypt, verify, and restore a healthy
# snapshot in minutes so a corrupted production database isn't a long outage.
# Parallel restore (`pg_restore -j`) is what keeps it fast; --clean --if-exists
# makes it idempotent, so re-running after a partial restore is safe.
#
# Runner requirements: pg_restore, psql, openssl on PATH. Restores over the
# network via DATABASE_URL (the TARGET database — usually a fresh/empty one, or
# the corrupted one being overwritten).
#
# Usage:
#   db-restore.sh <path/to/dbsos-*.dump.enc>   # a specific dump
#   db-restore.sh latest                       # newest dump in DBSOS_DIR
#
# Required env:
#   DATABASE_URL    target postgres connection URI to restore INTO.
#   DBSOS_KEY_FILE  path to the AES passphrase file used for the backup.
# Optional env:
#   DBSOS_DIR       dir to resolve `latest` from (default: ./backups).
#   DBSOS_JOBS      parallel restore workers (default: 4).
#   DBSOS_YES       set to 1 to skip the confirmation prompt (for automation).
#
# This is DESTRUCTIVE to the target database (--clean drops existing objects).
# It refuses to run without an explicit confirmation unless DBSOS_YES=1.
#
set -euo pipefail

fail() { echo "db-restore: $*" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is required (the TARGET database to restore into)}"
: "${DBSOS_KEY_FILE:?DBSOS_KEY_FILE is required}"
DBSOS_DIR="${DBSOS_DIR:-./backups}"
DBSOS_JOBS="${DBSOS_JOBS:-4}"
[ "${1:-}" ] || fail "usage: db-restore.sh <dump.enc | latest>"

command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found on PATH"
command -v psql       >/dev/null 2>&1 || fail "psql not found on PATH"
command -v openssl    >/dev/null 2>&1 || fail "openssl not found on PATH"
[ -r "$DBSOS_KEY_FILE" ] || fail "DBSOS_KEY_FILE ($DBSOS_KEY_FILE) is not readable"

if [ "$1" = "latest" ]; then
  src="$(find "$DBSOS_DIR" -maxdepth 1 -name 'dbsos-*.dump.enc' -type f | sort | tail -n 1)"
  [ -n "$src" ] || fail "no dbsos-*.dump.enc found in $DBSOS_DIR"
else
  src="$1"
fi
[ -r "$src" ] || fail "backup file ($src) is not readable"

# Decrypt to a temp plaintext archive (custom format). We decrypt to disk rather
# than stream so we can verify the TOC first and then run a parallel restore
# (`pg_restore -j` needs a real file, not a pipe).
work="$(mktemp -d)"
plain="$work/dbsos.dump"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

echo "db-restore: decrypting $src"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$DBSOS_KEY_FILE" -in "$src" -out "$plain" \
  || fail "decryption failed (wrong key?)"

echo "db-restore: verifying archive"
pg_restore -l "$plain" >/dev/null 2>&1 || fail "archive is unreadable/corrupt"

if [ "${DBSOS_YES:-}" != "1" ]; then
  echo "db-restore: about to WIPE and restore the target database from $src"
  echo "db-restore: stop the app first so nothing writes mid-restore."
  printf "db-restore: type 'restore' to proceed: "
  read -r answer
  [ "$answer" = "restore" ] || fail "aborted"
fi

# Reset to a clean slate before restoring, rather than `pg_restore --clean`.
# --clean issues per-object DROPs that fail on foreign-key dependency ordering
# (dropping a referenced table before its referencer) and, with --exit-on-error,
# abort half-way — leaving the target worse than before. Dropping and recreating
# the public schema wipes everything in one dependency-safe CASCADE, so the
# restore then runs into a guaranteed-empty schema with no DROP ordering to get
# wrong. The target database itself must already exist (create it empty, or
# point at the corrupted one — this only resets its schema, not the database).
echo "db-restore: resetting target schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
  || fail "could not reset target schema (is the app still connected? stop it first)"

echo "db-restore: restoring (parallel: $DBSOS_JOBS jobs)"
# No --clean needed: the schema is empty. --no-owner/--no-privileges match the
# dump flags. --exit-on-error so a broken restore fails loudly.
pg_restore --no-owner --no-privileges --exit-on-error \
  -j "$DBSOS_JOBS" --dbname "$DATABASE_URL" "$plain"

echo "db-restore: OK — restored $src"
echo "db-restore: reminder — mailbox credentials decrypt only with the MASTER_KEY keyring in force (GH #172)."
