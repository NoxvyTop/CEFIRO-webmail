# Base images are pinned by DIGEST, not by the moving `1.3` tag (GH #260).
# A tag is a pointer its publisher can repoint at any moment, so the same commit
# rebuilt a week later produced different bytes — which quietly undoes the
# immutability the `:sha-<commit>` tag promises (GH #190): rolling back to an
# exact tag is only meaningful if that tag names exactly one build input set.
#
# Refresh deliberately, never incidentally:
#   docker buildx imagetools inspect oven/bun:1.3      --format '{{.Manifest.Digest}}'
#   docker buildx imagetools inspect oven/bun:1.3-slim --format '{{.Manifest.Digest}}'
# The human-readable tag stays in the reference so the version is still greppable;
# Docker resolves the digest and ignores it.
FROM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bunx vite build

# Separate install with devDependencies stripped so the runtime image only
# ships production dependencies.
FROM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS prod-deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# The dbSOS scripts travel WITH the image (GH #256). The runbook tells the
# operator to run scripts/db-backup.sh on day one, but the deploy lives in
# another repository and this one is private, so an operator had no way to
# obtain them — step 9 of the first-boot checklist was unfinishable. Shipping
# them here makes the image the distribution channel: they are extracted with
# `docker cp` and run from a container that has pg_dump/openssl (see
# docs/OPERATIONS.md → dbSOS). They are NOT run inside this image: it carries
# neither postgresql-client nor openssl, and adding them would grow the runtime
# attack surface of the web-facing container to serve a job that runs elsewhere.
# --chmod is explicit because the executable bit does not survive every build
# context (a Windows checkout, a tarball), and a backup script that is not
# executable fails on the day it is needed.
COPY --from=build --chmod=755 /app/scripts/db-backup.sh /app/scripts/db-restore.sh ./scripts/
ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
USER bun
EXPOSE 8080
# LIVENESS probe (GH #242), not readiness. It answers one question — is this
# process up and serving HTTP — and nothing about its dependencies.
#
# It used to probe /api/health, which returns 503 when Postgres or Stalwart is
# degraded (GH #197). That made Docker mark this container UNHEALTHY whenever a
# DEPENDENCY was down: Swarm restarts an unhealthy task, `depends_on:
# service_healthy` refuses to start what waits on it, and every dashboard shows
# the webmail as broken — while the process is fine, still serving the SPA and
# still answering the readiness endpoint correctly. Restarting this container
# has never fixed a down Postgres or Stalwart, so making a dependency outage
# restart it converts one incident into two.
#
# Dependency state has NOT moved: /api/health still answers 200/503 with the
# per-check detail, and that is what a load balancer or an orchestrator's
# READINESS probe must poll to drain this instance. See docs/OPERATIONS.md.
#
# Uses bun rather than curl/wget, which the slim image does not ship. The app
# listens on PORT (default 8080); keep this in sync if PORT is overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/server/src/index.ts"]
