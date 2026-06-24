import { buildServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const app = buildServer();
  await app.listen({ port, host });

  console.log(`fault-provider listening at http://${host}:${port}/v1`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
