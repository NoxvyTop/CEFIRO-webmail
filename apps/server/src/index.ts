import { createApp } from "./app";
import { createDb } from "./infra/db/client";
import { checkDb } from "./infra/db/health";

const port = Number(process.env.PORT ?? 8080);
const dbUrl = process.env.DATABASE_URL;
const db = dbUrl ? createDb(dbUrl) : undefined;
const app = createApp(db ? { postgres: () => checkDb(db) } : {});

console.log(JSON.stringify({ level: "info", msg: "server started", port }));

export default { port, fetch: app.fetch };
