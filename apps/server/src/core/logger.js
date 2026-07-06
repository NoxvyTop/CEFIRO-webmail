export function log(level, msg, fields = {}) {
    const line = JSON.stringify({
        level,
        msg,
        time: new Date().toISOString(),
        ...fields,
    });
    if (level === "error")
        console.error(line);
    else if (level === "warn")
        console.warn(line);
    else
        console.log(line);
}
