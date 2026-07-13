import { fileURLToPath } from "node:url";
import { createDb } from "../src/infra/db/client";
import { migrate } from "../src/infra/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = createDb(url);
await migrate(sql, fileURLToPath(new URL("../migrations", import.meta.url)));
await sql.end();
console.log("migrations applied");
