import postgres from "postgres";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  return postgres(url, { max: 10, onnotice: () => {} });
}
