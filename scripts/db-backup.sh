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
#
set -euo pipefail

fail() { echo "db-backup: $*" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DBSOS_KEY_FILE:?DBSOS_KEY_FILE is required (path to the AES passphrase, stored separately from the backups)}"
DBSOS_DIR="${DBSOS_DIR:-./backups}"
DBSOS_RETENTION_DAYS="${DBSOS_RETENTION_DAYS:-7}"

command -v pg_dump    >/dev/null 2>&1 || fail "pg_dump not found on PATH"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found on PATH"
command -v openssl    >/dev/null 2>&1 || fail "openssl not found on PATH"
[ -r "$DBSOS_KEY_FILE" ] || fail "DBSOS_KEY_FILE ($DBSOS_KEY_FILE) is not readable"

# Guardrail: refuse to write backups into the same directory the key lives in,
# which would defeat the point of encrypting them.
key_dir="$(cd "$(dirname "$DBSOS_KEY_FILE")" && pwd)"
mkdir -p "$DBSOS_DIR"
out_dir="$(cd "$DBSOS_DIR" && pwd)"
[ "$key_dir" != "$out_dir" ] || fail "DBSOS_KEY_FILE must not live inside DBSOS_DIR ($out_dir)"

# UTC, second-granularity, sortable. Not using Date-derived randomness — the
# timestamp is the only variable and it sorts lexicographically.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$out_dir/dbsos-$stamp.dump.enc"
tmp="$out_dir/.dbsos-$stamp.partial"

cleanup() { rm -f "$tmp" "$tmp.verify"; }
trap cleanup EXIT

echo "db-backup: dumping to $final"
# -Fc custom format: compressed + parallel-restorable. Encrypt streaming so the
# plaintext dump is never written to disk. pbkdf2 + salt so the passphrase file
# isn't used as a raw key.
pg_dump -Fc --no-owner --no-privileges "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$DBSOS_KEY_FILE" \
  > "$tmp"

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
  fail "integrity check failed (could not decrypt or read the archive) — dump discarded"
fi
rm -f "$verify"

mv "$tmp" "$final"
trap - EXIT
size="$(du -h "$final" | cut -f1)"
echo "db-backup: OK $final ($size)"

# Retention: drop encrypted dumps older than the window. Only touches our own
# dbsos-*.dump.enc, never the key or anything else in the dir.
if [ "$DBSOS_RETENTION_DAYS" -gt 0 ]; then
  find "$out_dir" -maxdepth 1 -name 'dbsos-*.dump.enc' -type f \
    -mtime "+$DBSOS_RETENTION_DAYS" -print -delete \
    | sed 's/^/db-backup: pruned /' || true
fi
