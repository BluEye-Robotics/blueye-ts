import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import {
  type InMemoryReply,
  InMemoryTransport,
} from "../src/in-memory-transport";
import { RequestPipeline } from "../src/request-pipeline";

const decodeUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const createPipeline = () => {
  const transport = new InMemoryTransport();
  const endpoint = transport.listen("mem://rpc");
  const socket = transport.createSocket("req");
  socket.connect("mem://rpc");
  const pipeline = new RequestPipeline(socket);
  return { transport, endpoint, pipeline };
};

describe("RequestPipeline", () => {
  it("resolves each request with its own reply, in order", async () => {
    const { endpoint, pipeline } = createPipeline();

    endpoint.onMessage(([topic], reply) => {
      reply([`echo:${decodeUtf8(topic)}`, Uint8Array.of(1)]);
    });

    const [first, second] = await Promise.all([
      pipeline.request(["one", Uint8Array.of(1)], 500),
      pipeline.request(["two", Uint8Array.of(2)], 500),
    ]);

    expect(decodeUtf8(first[0])).toBe("echo:one");
    expect(decodeUtf8(second[0])).toBe("echo:two");
  });

  it("rejects on timeout without poisoning later requests", async () => {
    const { endpoint, pipeline } = createPipeline();

    let silent = true;
    const pendingReplies: InMemoryReply[] = [];
    endpoint.onMessage(([topic], reply) => {
      if (silent) {
        pendingReplies.push(reply);
        return;
      }
      reply([`echo:${decodeUtf8(topic)}`, Uint8Array.of(1)]);
    });

    await expect(
      pipeline.request(["one", Uint8Array.of(1)], 50),
    ).rejects.toThrow(/request timed out/);

    // The reply is still owed — requests fail fast rather than mis-correlating
    await expect(
      pipeline.request(["two", Uint8Array.of(2)], 50),
    ).rejects.toThrow(/reply is still owed/);

    // The owed reply arrives late and is discarded, unblocking the pipeline
    pendingReplies[0]?.(["echo:one", Uint8Array.of(1)]);
    await delay(0);

    silent = false;
    const reply = await pipeline.request(["three", Uint8Array.of(3)], 500);
    expect(decodeUtf8(reply[0])).toBe("echo:three");
  });

  it("never delivers a late reply to a later request", async () => {
    const { endpoint, pipeline } = createPipeline();

    let mode: "hold" | "echo" = "hold";
    const held: InMemoryReply[] = [];
    endpoint.onMessage(([topic], reply) => {
      if (mode === "hold") {
        held.push(reply);
        return;
      }
      reply([`echo:${decodeUtf8(topic)}`, Uint8Array.of(1)]);
    });

    await expect(
      pipeline.request(["stale", Uint8Array.of(1)], 50),
    ).rejects.toThrow(/request timed out/);

    // Release the stale reply, then immediately issue a fresh request
    held[0]?.(["echo:stale", Uint8Array.of(9)]);
    mode = "echo";
    const reply = await pipeline.request(["fresh", Uint8Array.of(2)], 500);

    expect(decodeUtf8(reply[0])).toBe("echo:fresh");
  });

  it("rejects the in-flight request when the connection is lost", async () => {
    const { endpoint, pipeline } = createPipeline();

    endpoint.onMessage(() => {
      // Never reply — the server dies mid-request
    });

    const inFlight = pipeline.request(["one", Uint8Array.of(1)], 5_000);
    await delay(0);
    endpoint.close();

    await expect(inFlight).rejects.toThrow(/connection lost/);
  });

  it("recovers after a connection loss cleared an owed reply", async () => {
    const { transport, endpoint, pipeline } = createPipeline();

    endpoint.onMessage(() => {
      // Never reply
    });

    await expect(
      pipeline.request(["one", Uint8Array.of(1)], 50),
    ).rejects.toThrow(/request timed out/);

    endpoint.close();
    await delay(0);

    const revived = transport.listen("mem://rpc");
    revived.onMessage(([topic], reply) => {
      reply([`echo:${decodeUtf8(topic)}`, Uint8Array.of(1)]);
    });
    await delay(0);

    const reply = await pipeline.request(["two", Uint8Array.of(2)], 500);
    expect(decodeUtf8(reply[0])).toBe("echo:two");
  });
});
