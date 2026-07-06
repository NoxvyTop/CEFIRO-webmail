import type { Db } from "./client";

export async function checkDb(sql: Db): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
