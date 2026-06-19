import { buildServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildServer();

await app.listen({ port, host });

console.log(`Mock streaming provider listening at http://${host}:${port}/v1`);
