import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Protocol } from "../shared/types.js";
import { handleScenario } from "./scenarioEngine.js";
import type { ServerTraceStore } from "./trace.js";
import { createServerTraceStore, registerTraceRoutes } from "./trace.js";

declare module "fastify" {
  interface FastifyInstance {
    traceStore: ServerTraceStore;
  }
}

export function buildServer() {
  const app = Fastify({ logger: false });
  const traceStore = createServerTraceStore();

  app.decorate("traceStore", traceStore);
  registerTraceRoutes(app, traceStore);

  async function handle(protocol: Protocol, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const scenario = (request.query as { scenario?: string } | undefined)?.scenario ?? "normal";
    request.log.info({ protocol, scenario }, "mock request");
    await handleScenario(protocol, request, reply, traceStore);
  }

  app.post("/v1/chat/completions", async (request, reply) => handle("openai-chat", request, reply));
  app.post("/v1/responses", async (request, reply) => handle("openai-responses", request, reply));
  app.post("/v1/messages", async (request, reply) => handle("anthropic", request, reply));

  app.get("/health", async () => ({ ok: true }));

  return app;
}
