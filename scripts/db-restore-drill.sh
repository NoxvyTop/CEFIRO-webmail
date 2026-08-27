#!/usr/bin/env bash
#
# dbSOS restore DRILL (GH #258).
#
# db-backup.sh only verifies the archive INDEX (`pg_restore -l`); nothing ever
# proved the data actually RESTORES. This drill closes that gap end to end: it
# seeds a throwaway source database, runs the REAL db-backup.sh over it, restores
# the encrypted dump into a fresh target database with the REAL db-restore.sh,
# and compares the two at the data level. Any difference — or any failure along
# the way — exits non-zero and loudly, so a restore path that has silently rotted
# is caught in CI (see .github/workflows/ci.yml, job `restore-drill`) instead of
# during an outage.
#
# It exercises the SAME two scripts an operator runs in an emergency, so a
# regression in either is what fails this drill.
#
# It NEVER touches the application database: it creates and drops its own
# throwaway databases off ADMIN_DATABASE_URL and leaves everything else alone.
#
# Required env:
#   ADMIN_DATABASE_URL  connection URI to a maintenance database (e.g. the
#                       server's `postgres` db) whose role may CREATE/DROP
#                       DATABASE. Must carry NO query string: the drill swaps
#                       only the trailing database name to address its own DBs.
# Optional env:
#   DRILL_SRC_DB   throwaway source db name  (default: dbsos_drill_src).
#   DRILL_DST_DB   throwaway target db name  (default: dbsos_drill_dst).
#   DRILL_ROWS     rows to seed per table    (default: 500).
set -euo pipefail

fail() { echo "db-restore-drill: $*" >&2; exit 1; }

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required (a maintenance DB whose role may CREATE/DROP DATABASE)}"
DRILL_SRC_DB="${DRILL_SRC_DB:-dbsos_drill_src}"
DRILL_DST_DB="${DRILL_DST_DB:-dbsos_drill_dst}"
DRILL_ROWS="${DRILL_ROWS:-500}"

command -v psql       >/dev/null 2>&1 || fail "psql not found on PATH"
command -v pg_dump    >/dev/null 2>&1 || fail "pg_dump not found on PATH"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found on PATH"
command -v openssl    >/dev/null 2>&1 || fail "openssl not found on PATH"

here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/db-backup.sh" ]  || fail "db-backup.sh not found next to this script"
[ -f "$here/db-restore.sh" ] || fail "db-restore.sh not found next to this script"

# Build per-database URLs by swapping the trailing db name. A query string would
# make this naive swap corrupt the URL, so refuse one outright.
case "$ADMIN_DATABASE_URL" in
  *\?*) fail "ADMIN_DATABASE_URL must not contain a query string" ;;
esac
base="${ADMIN_DATABASE_URL%/*}"
src_url="$base/$DRILL_SRC_DB"
dst_url="$base/$DRILL_DST_DB"

# Throwaway workspace: an isolated backups dir plus a key file OUTSIDE it (the
# backup script refuses a key that lives beside the dumps).
work="$(mktemp -d)"
backups="$work/backups"
keyfile="$work/dbsos.key"
mkdir -p "$backups"
head -c 48 /dev/urandom | openssl base64 -A > "$keyfile"

drop_dbs() {
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"$DRILL_SRC_DB\" WITH (FORCE);" \
    -c "DROP DATABASE IF EXISTS \"$DRILL_DST_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
}
cleanup() { drop_dbs; rm -rf "$work"; }
trap cleanup EXIT

echo "db-restore-drill: creating throwaway databases"
drop_dbs
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -c "CREATE DATABASE \"$DRILL_SRC_DB\";" \
  -c "CREATE DATABASE \"$DRILL_DST_DB\";" \
  || fail "could not create throwaway databases (does the role have CREATEDB?)"

echo "db-restore-drill: seeding source with $DRILL_ROWS rows/table"
# A schema with a foreign key on purpose: a restore that gets DROP/CREATE
# ordering wrong fails here rather than passing on one flat table. bytea and
# timestamptz exercise binary and time round-tripping.
psql "$src_url" -v ON_ERROR_STOP=1 -q -v rows="$DRILL_ROWS" <<'SQL'
create table drill_parent (
  id     bigserial primary key,
  label  text not null,
  blob   bytea not null,
  amount numeric(12,2) not null,
  at     timestamptz not null
);
create table drill_child (
  id        bigserial primary key,
  parent_id bigint not null references drill_parent(id),
  note      text not null
);
insert into drill_parent (label, blob, amount, at)
select 'row ' || g,
       decode(md5(g::text), 'hex'),
       (g * 1.01)::numeric(12,2),
       timestamptz '2020-01-01 00:00:00+00' + (g || ' seconds')::interval
from generate_series(1, :rows) g;
insert into drill_child (parent_id, note)
select p.id, 'note for ' || p.id from drill_parent p;
SQL

# An order-independent content digest of every seeded table, computed the same
# way on both databases (same server, so timestamptz renders identically). If
# backup->restore lost, reordered, or corrupted a single row, the digests differ.
digest() {
  psql "$1" -tAX -v ON_ERROR_STOP=1 <<'SQL'
select
  (select coalesce(md5(string_agg(t::text, ',' order by t.id)), 'empty') from drill_parent t) || ':' ||
  (select coalesce(md5(string_agg(t::text, ',' order by t.id)), 'empty') from drill_child  t) || ':' ||
  (select count(*)::text from drill_parent) || ':' ||
  (select count(*)::text from drill_child);
SQL
}

src_digest="$(digest "$src_url")"
[ -n "$src_digest" ] || fail "could not read source digest"

echo "db-restore-drill: backing up the source (real db-backup.sh)"
# DBSOS_RETENTION_DAYS=0 skips pruning so the just-written dump is never removed.
DATABASE_URL="$src_url" DBSOS_KEY_FILE="$keyfile" DBSOS_DIR="$backups" DBSOS_RETENTION_DAYS=0 \
  bash "$here/db-backup.sh" || fail "db-backup.sh failed"

echo "db-restore-drill: restoring into a fresh target (real db-restore.sh)"
DATABASE_URL="$dst_url" DBSOS_KEY_FILE="$keyfile" DBSOS_DIR="$backups" DBSOS_YES=1 \
  bash "$here/db-restore.sh" latest || fail "db-restore.sh failed"

echo "db-restore-drill: comparing source and restored data"
dst_digest="$(digest "$dst_url")"
if [ "$src_digest" != "$dst_digest" ]; then
  echo "db-restore-drill: MISMATCH — the restore did not reproduce the source" >&2
  echo "  source:   $src_digest" >&2
  echo "  restored: $dst_digest" >&2
  fail "restore drill FAILED: restored data differs from source"
fi

echo "db-restore-drill: OK — restore reproduced the source ($src_digest)"
