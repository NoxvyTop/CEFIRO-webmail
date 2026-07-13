import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client";

export async function migrate(sql: Db, dir: string): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await sql`select 1 from schema_migrations where name = ${file}`;
    if (applied.length > 0) continue;
    const body = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
  }
}
