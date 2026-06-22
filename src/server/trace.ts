import type { FastifyInstance, FastifyReply } from "fastify";

import type { TraceEvent } from "../shared/trace.js";

export interface ServerTraceStoreOptions {
  maxEventsPerSession: number;
}

export type TraceListener = (event: TraceEvent) => void;
export type UnsubscribeTraceListener = () => void;

export class ServerTraceStore {
  readonly #eventsBySession = new Map<string, TraceEvent[]>();
  readonly #listenersBySession = new Map<string, Set<TraceListener>>();
  readonly #maxEventsPerSession: number;

  constructor(options: ServerTraceStoreOptions) {
    this.#maxEventsPerSession = options.maxEventsPerSession;
  }

  append(event: TraceEvent): void {
    const events = this.#eventsBySession.get(event.debugSessionId) ?? [];
    events.push(event);
    if (events.length > this.#maxEventsPerSession) {
      events.splice(0, events.length - this.#maxEventsPerSession);
    }
    this.#eventsBySession.set(event.debugSessionId, events);

    const listeners = this.#listenersBySession.get(event.debugSessionId);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  snapshot(debugSessionId: string): TraceEvent[] {
    return [...(this.#eventsBySession.get(debugSessionId) ?? [])];
  }

  subscribe(debugSessionId: string, listener: TraceListener): UnsubscribeTraceListener {
    const listeners = this.#listenersBySession.get(debugSessionId) ?? new Set<TraceListener>();
    listeners.add(listener);
    this.#listenersBySession.set(debugSessionId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listenersBySession.delete(debugSessionId);
      }
    };
  }
}

export function createServerTraceStore(
  options: ServerTraceStoreOptions = { maxEventsPerSession: 500 },
): ServerTraceStore {
  return new ServerTraceStore(options);
}

export function registerTraceRoutes(app: FastifyInstance, store: ServerTraceStore): void {
  app.get<{ Params: { debugSessionId: string } }>(
    "/debug/traces/:debugSessionId",
    async (request, reply) => {
      const { debugSessionId } = request.params;

      reply.hijack();
      startTraceStream(reply);

      for (const event of store.snapshot(debugSessionId)) {
        writeTraceEvent(reply, event);
      }

      const unsubscribe = store.subscribe(debugSessionId, (event) => {
        writeTraceEvent(reply, event);
      });
      request.raw.on("close", unsubscribe);
    },
  );
}

function startTraceStream(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
}

function writeTraceEvent(reply: FastifyReply, event: TraceEvent): void {
  reply.raw.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`);
}
