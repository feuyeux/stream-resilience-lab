import type { FastifyReply } from "fastify";

export function prepareSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
}

export function writeDataEvent(reply: FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function writeNamedEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeRaw(reply: FastifyReply, raw: string): void {
  reply.raw.write(raw);
}

export function endSse(reply: FastifyReply): void {
  reply.raw.end();
}

export function destroySse(reply: FastifyReply): void {
  reply.raw.destroy();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
