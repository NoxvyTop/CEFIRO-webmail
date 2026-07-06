type Level = "info" | "warn" | "error";

export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
