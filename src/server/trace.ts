import type { FastifyInstance, FastifyReply } from "fastify";

import type { TraceEvent } from "../shared/trace.js";

export interface ServerTraceStoreOptions {
  maxEventsPerSession?: number;
  maxSessions?: number;
}

export type TraceListener = (event: TraceEvent) => void;
export type UnsubscribeTraceListener = () => void;

interface ResolvedServerTraceStoreOptions {
  maxEventsPerSession: number;
  maxSessions: number;
}

export interface TraceWritable {
  destroyed?: boolean;
  writableEnded?: boolean;
  write(frame: string): boolean;
}

export class ServerTraceStore {
  readonly #eventsBySession = new Map<string, TraceEvent[]>();
  readonly #listenersBySession = new Map<string, Set<TraceListener>>();
  readonly #options: ResolvedServerTraceStoreOptions;

  constructor(options: ResolvedServerTraceStoreOptions) {
    this.#options = options;
  }

  append(event: TraceEvent): void {
    const events = this.#eventsBySession.get(event.debugSessionId) ?? [];
    events.push(event);
    if (events.length > this.#options.maxEventsPerSession) {
      events.splice(0, events.length - this.#options.maxEventsPerSession);
    }
    this.#touchSession(event.debugSessionId, events);
    this.#evictExcessSessions();

    const listeners = this.#listenersBySession.get(event.debugSessionId);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Trace delivery is best-effort debug output; a failed listener must not
        // break provider request handling or other subscribers.
      }
    }
  }

  snapshot(debugSessionId: string): TraceEvent[] {
    const events = this.#eventsBySession.get(debugSessionId);
    if (!events) return [];

    this.#touchSession(debugSessionId, events);
    return [...events];
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

  #touchSession(debugSessionId: string, events: TraceEvent[]): void {
    this.#eventsBySession.delete(debugSessionId);
    this.#eventsBySession.set(debugSessionId, events);
  }

  #evictExcessSessions(): void {
    while (this.#eventsBySession.size > this.#options.maxSessions) {
      const inactiveSessionId = this.#oldestSessionId((debugSessionId) => !this.#hasActiveSubscribers(debugSessionId));
      const sessionId = inactiveSessionId ?? this.#oldestSessionId();
      if (!sessionId) return;

      this.#eventsBySession.delete(sessionId);
    }
  }

  #oldestSessionId(predicate: (debugSessionId: string) => boolean = () => true): string | undefined {
    for (const debugSessionId of this.#eventsBySession.keys()) {
      if (predicate(debugSessionId)) {
        return debugSessionId;
      }
    }
    return undefined;
  }

  #hasActiveSubscribers(debugSessionId: string): boolean {
    return (this.#listenersBySession.get(debugSessionId)?.size ?? 0) > 0;
  }
}

export function createServerTraceStore(
  options: ServerTraceStoreOptions = {},
): ServerTraceStore {
  return new ServerTraceStore({
    maxEventsPerSession: options.maxEventsPerSession ?? 500,
    maxSessions: options.maxSessions ?? 100,
  });
}

export function registerTraceRoutes(app: FastifyInstance, store: ServerTraceStore): void {
  app.get<{ Params: { debugSessionId: string } }>(
    "/debug/traces/:debugSessionId",
    async (request, reply) => {
      const { debugSessionId } = request.params;

      reply.hijack();
      startTraceStream(reply);

      let closed = false;
      let unsubscribe: UnsubscribeTraceListener | undefined;
      const cleanup = () => {
        if (closed) return;

        closed = true;
        unsubscribe?.();
      };
      const disconnect = () => {
        cleanup();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.destroy();
        }
      };
      const send = (event: TraceEvent) => {
        if (closed) return;
        if (!writeTraceSseFrame(reply.raw, event)) {
          disconnect();
        }
      };

      request.raw.on("close", cleanup);
      reply.raw.on("close", cleanup);
      reply.raw.on("error", cleanup);

      for (const event of store.snapshot(debugSessionId)) {
        send(event);
      }
      if (closed) return;

      unsubscribe = store.subscribe(debugSessionId, send);
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

export function writeTraceSseFrame(raw: TraceWritable, event: TraceEvent): boolean {
  if (raw.destroyed || raw.writableEnded) {
    return false;
  }

  try {
    return raw.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`) !== false;
  } catch {
    return false;
  }
}
