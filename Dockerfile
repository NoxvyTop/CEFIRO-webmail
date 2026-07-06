FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bunx vite build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
USER bun
EXPOSE 8080
CMD ["bun", "apps/server/src/index.ts"]
