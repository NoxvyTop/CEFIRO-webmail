import { createApp } from "./app";
const port = Number(process.env.PORT ?? 8080);
const app = createApp();
console.log(JSON.stringify({ level: "info", msg: "server started", port }));
export default { port, fetch: app.fetch };
