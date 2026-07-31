FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bunx vite build

# Separate install with devDependencies stripped so the runtime image only
# ships production dependencies.
FROM oven/bun:1.3 AS prod-deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
USER bun
EXPOSE 8080
# Readiness probe (GH #197): /api/health returns 503 when Postgres or Stalwart
# is degraded, so `r.ok` (200 only) is the health signal. Uses bun rather than
# curl/wget, which the slim image does not ship. The app listens on PORT
# (default 8080); keep this in sync if PORT is overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/server/src/index.ts"]
