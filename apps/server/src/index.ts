import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";

const port = Number(process.env.PORT ?? 8080);
const dbUrl = process.env.DATABASE_URL;
const db = dbUrl ? createDb(dbUrl) : undefined;
const app = createApp(db ? { checks: { postgres: () => checkDb(db) } } : {});

if (process.env.NODE_ENV === "production") {
  const root = process.env.STATIC_DIR ?? "../web/dist";
  app.use("*", serveStatic({ root }));
  app.use("*", serveStatic({ root, path: "index.html" }));
}

console.log(JSON.stringify({ level: "info", msg: "server started", port }));

export default { port, fetch: app.fetch };
