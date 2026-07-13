#!/bin/sh
# Entry script for the dev container: install deps, then run the API
# watcher and the Vite dev server together. Runs inside oven/bun.
set -e

bun install

# nodemon in legacy (polling) mode: file-change events do not cross
# Windows bind mounts, so event-based watchers miss edits from the host.
(cd apps/server && exec bunx nodemon --legacy-watch --watch src --ext ts --exec "bun src/index.ts") &

cd apps/web && exec bunx vite --host 0.0.0.0 --port 5173
