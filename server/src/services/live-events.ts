import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

// Redis pub/sub for cross-replica event distribution
let redisPub: { publish(channel: string, message: string): Promise<unknown> } | null = null;
let redisSub: { subscribe(channel: string): Promise<unknown>; on(event: string, cb: (...args: unknown[]) => void): void } | null = null;
let redisReady = false;

// Unique ID for this process to skip self-published Redis messages
const podId = `${process.pid}-${Date.now()}`;

async function initRedis() {
  const redisUrl = process.env.PAPERCLIP_RATE_LIMIT_REDIS_URL;
  if (!redisUrl || redisReady) return;
  redisReady = true;

  try {
    const ioredis = await import("ioredis");
    const Redis = ioredis.default ?? ioredis;
    redisPub = new (Redis as any)(redisUrl);
    redisSub = new (Redis as any)(redisUrl);

    redisSub!.subscribe("paperclip:live-events");
    redisSub!.on("message", (_channel: unknown, message: unknown) => {
      try {
        const envelope = JSON.parse(message as string) as { origin: string; event: LiveEvent };
        // Skip messages published by this pod (already emitted locally)
        if (envelope.origin === podId) return;
        emitter.emit(envelope.event.companyId, envelope.event);
        emitter.emit("*", envelope.event);
      } catch { /* ignore malformed messages */ }
    });
  } catch (err) {
    // Redis not available — fall back to local-only events
    redisPub = null;
    redisSub = null;
  }
}

// Initialize Redis on module load (non-blocking)
void initRedis();

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  if (redisPub) {
    redisPub.publish("paperclip:live-events", JSON.stringify({ origin: podId, event })).catch(() => {});
  }
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  if (redisPub) {
    redisPub.publish("paperclip:live-events", JSON.stringify({ origin: podId, event })).catch(() => {});
  }
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => { emitter.off(companyId, listener); };
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => { emitter.off("*", listener); };
}
