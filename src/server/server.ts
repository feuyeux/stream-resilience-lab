import Fastify, { type RouteShorthandOptions } from "fastify";
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

interface RequestBody {
  model?: string;
  stream?: boolean;
  input?: string;
  messages?: unknown[];
  max_tokens?: number;
  metadata?: {
    mock_scenario?: string;
    debug_session_id?: string;
    debug_attempt_id?: string;
    mock_request_id?: string;
  };
}

interface RequestQuery {
  scenario?: string;
}

const postRouteOptions: RouteShorthandOptions = {
  schema: {
    body: {
      type: "object",
      properties: {
        model: { type: "string" },
        stream: { type: "boolean" },
        input: { type: "string" },
        messages: { type: "array" },
        max_tokens: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            mock_scenario: { type: "string" },
            debug_session_id: { type: "string" },
            debug_attempt_id: { type: "string" },
            mock_request_id: { type: "string" }
          }
        }
      }
    },
    querystring: {
      type: "object",
      properties: {
        scenario: { type: "string" }
      }
    }
  }
};

export function buildServer() {
  const app = Fastify({ logger: false });
  const traceStore = createServerTraceStore();

  app.decorate("traceStore", traceStore);
  registerTraceRoutes(app, traceStore);

  const handle = async (protocol: Protocol, request: FastifyRequest<{ Body: RequestBody; Querystring: RequestQuery }>, reply: FastifyReply): Promise<void> => {
    const scenario = request.query.scenario ?? "normal";
    request.log.info({ protocol, scenario }, "mock request");
    await handleScenario(protocol, request, reply, traceStore);
  };

  app.post<{ Body: RequestBody; Querystring: RequestQuery }>("/v1/chat/completions", postRouteOptions, async (request, reply) => handle("openai-chat", request, reply));
  app.post<{ Body: RequestBody; Querystring: RequestQuery }>("/v1/responses", postRouteOptions, async (request, reply) => handle("openai-responses", request, reply));
  app.post<{ Body: RequestBody; Querystring: RequestQuery }>("/v1/messages", postRouteOptions, async (request, reply) => handle("anthropic", request, reply));

  app.get("/health", async () => ({ ok: true }));

  return app;
}
