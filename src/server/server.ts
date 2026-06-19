import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Protocol } from "../shared/types.js";
import { handleScenario } from "./scenarioEngine.js";

export function buildServer() {
  const app = Fastify({ logger: false });

  async function handle(protocol: Protocol, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const scenario = (request.query as { scenario?: string } | undefined)?.scenario ?? "normal";
    request.log.info({ protocol, scenario }, "mock request");
    await handleScenario(protocol, request, reply);
  }

  app.post("/v1/chat/completions", async (request, reply) => handle("openai-chat", request, reply));
  app.post("/v1/responses", async (request, reply) => handle("openai-responses", request, reply));
  app.post("/v1/messages", async (request, reply) => handle("anthropic", request, reply));

  app.get("/health", async () => ({ ok: true }));

  return app;
}
