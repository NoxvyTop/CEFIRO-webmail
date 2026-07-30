# Stalwart E2E fixture

Pre-provisioned Stalwart Mail Server (CE) image used as the mail backend for
Céfiro webmail end-to-end tests. It boots with the setup wizard already
completed, so tests can hit a real JMAP/IMAP/SMTP server immediately without
waiting on interactive provisioning.

## What's in here

- `Dockerfile` — builds `FROM stalwartlabs/stalwart:v0.16`, copies `seed/` into
  `/seed` and installs `entrypoint.sh` as the container entrypoint.
- `entrypoint.sh` — on first boot, copies `/seed/etc/*` into `/etc/stalwart/`
  and `/seed/data/*` into `/var/lib/stalwart/` (these paths are declared as
  `VOLUME`s by the base image, so they start empty on every fresh container —
  the entrypoint re-seeds them before starting the server). It only seeds
  when the target files don't already exist, so re-running the container
  against a persisted volume won't clobber later state.
- `seed/etc/config.json` — the Stalwart configuration produced by the setup
  wizard (domain, admin account, listeners, storage backend, etc).
- `seed/data/` — the RocksDB store (SST files, manifest, log, identity) that
  backs Stalwart's internal directory/store, already containing the
  provisioned domain and admin account.

## Baked-in test account

- Domain: `cefiro.test`
- Admin user: `admin@cefiro.test`
- Admin password: `n2BODWVsupeXnJ3L`

These are only valid for this fixture (local/E2E use). They are not
production credentials.

## How this was produced

1. Ran `stalwartlabs/stalwart:v0.16` fresh, with `/etc/stalwart` and
   `/var/lib/stalwart` bind-mounted to host directories.
2. Completed the web setup wizard once (created the `cefiro.test` domain and
   the `admin@cefiro.test` account with the password above).
3. Stopped the container and copied the resulting `/etc/stalwart/*` and
   `/var/lib/stalwart/*` into `seed/etc/` and `seed/data/` respectively.
4. Removed the stale `LOCK` file handling from the copy (the entrypoint drops
   `LOCK` after restoring `data/` so RocksDB doesn't refuse to open it).

The result is baked into this fixture directory and built into the
`cefiro-e2e-stalwart` image referenced by `docker-compose.e2e.yml`.

## How the published image is tagged

CI does not use a hand-written tag. The `fixture` job in `.github/workflows/ci.yml`
derives the tag from a hash of everything under `e2e/stalwart/`, checks whether
that exact image is already in the registry, and builds it only when it is not.

This is deliberate, and it replaced a fixed `v1` tag that was republished on
every fixture change. That design let an old commit be tested against a fixture
that did not exist when it was written — the pin looked like reproducibility
without providing it. Now a change to any file here produces a different tag by
construction, so a new fixture cannot take an old one's name, and a commit always
resolves to the bytes it was written against.

The practical consequence when rebuilding: there is nothing to bump. Change the
seed, push, and CI publishes and consumes the new tag on its own.

## Rebuilding the fixture (e.g. after bumping the Stalwart version)

1. Update the `FROM stalwartlabs/stalwart:vX.Y` tag in `Dockerfile`.
2. Run that image standalone with `/etc/stalwart` and `/var/lib/stalwart`
   bind-mounted to empty host directories.
3. Complete the setup wizard again with the same domain/account (or update
   the credentials documented above if they change).
4. Stop the container, delete the contents of `seed/etc/` and `seed/data/`,
   and copy the fresh `/etc/stalwart/*` and `/var/lib/stalwart/*` in their
   place.
5. Rebuild the image (`docker compose -f docker-compose.e2e.yml build stalwart`)
   and re-run the JMAP verification curl described in the repo's E2E docs.
