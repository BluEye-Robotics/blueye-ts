// biome-ignore-all lint/suspicious/noExplicitAny: test harness uses dynamic protocol indexing
// biome-ignore-all lint/style/noNonNullAssertion: harness always responds, so sendRequest cannot return null in these tests
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import * as jsmq from "@blueyerobotics/jszmq";
import { blueye } from "@blueyerobotics/protocol-definitions";
import { describe, expect, it } from "vitest";

import { BlueyeClient } from "../src/client";

const BATTERY = {
  level: 85,
  voltage: 18.67,
  temperature: 7.5,
};

const decodeUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const assertBattery = (actual: any) => {
  expect(actual.level).toBe(BATTERY.level);
  expect(actual.temperature).toBe(BATTERY.temperature);
  expect(Math.abs(actual.voltage - BATTERY.voltage)).toBeLessThan(1e-5);
};

const waitForEvent = async (
  emitter: any,
  eventName: string,
  timeout = 2_000,
) => {
  return Promise.race([
    once(emitter, eventName),
    delay(timeout).then(() => {
      throw new Error(`Timed out waiting for "${eventName}"`);
    }),
  ]);
};

const waitForState = async (
  client: any,
  targetState: string,
  timeout = 2_000,
): Promise<void> => {
  if (client.state === targetState) return;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for state "${targetState}"`)),
      timeout,
    );
    const check = () => {
      if (client.state === targetState) {
        clearTimeout(timer);
        client.removeListener("connected", check);
        client.removeListener("connecting", check);
        client.removeListener("disconnected", check);
        resolve();
      }
    };
    client.on("connected", check);
    client.on("connecting", check);
    client.on("disconnected", check);
  });
};

const getFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate port")));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(port);
      });
    });
    server.on("error", reject);
  });
};

const createUrls = async () => {
  const subPort = await getFreePort();
  const rpcPort = await getFreePort();
  const pubPort = await getFreePort();

  return {
    subUrl: `ws://127.0.0.1:${subPort}`,
    rpcUrl: `ws://127.0.0.1:${rpcPort}`,
    pubUrl: `ws://127.0.0.1:${pubPort}`,
    sonarUrl: `ws://127.0.0.1:${await getFreePort()}`,
  };
};

const topicName = (topic: Uint8Array) =>
  decodeUtf8(topic).split(".").at(-1) ?? "";

const encodeMessage = (key: string, message: any = {}) => {
  const protocol = (blueye.protocol as any)[key];
  const created = protocol.create(message);
  return protocol.encode(created).finish() as Uint8Array;
};

const createBatteryRep = () => ({
  battery: { ...BATTERY },
});

const createBatteryTel = () => ({
  battery: { ...BATTERY },
});

const createGetTelemetryRep = (type: string, payload: any) => ({
  payload: {
    typeUrl: `blueye.protocol.${type}`,
    value: (blueye.protocol as any)[type]
      .encode((blueye.protocol as any)[type].create(payload))
      .finish(),
  },
});

const createDroneInfoTel = (deviceId: number | null = null) => ({
  droneInfo: {
    blunuxVersion: "4.7.0",
    gp:
      deviceId == null
        ? undefined
        : {
            gp1: {
              deviceList: {
                devices: [{ deviceId, name: "" }],
              },
            },
          },
  },
});

const createMultibeamPingTel = (deviceId = 13) => ({
  ping: {
    range: 10,
    gain: 0.5,
    frequency: 750_000,
    speedOfSoundUsed: 1_500,
    numberOfRanges: 1,
    numberOfBeams: 1,
    step: 1,
    bearings: [0],
    pingData: Uint8Array.from([128]),
    deviceId,
  },
});

// Default RPC responses per telemetry type
const defaultTelemetryPayloads: Record<string, () => any> = {
  BatteryTel: createBatteryTel,
  DroneInfoTel: () => createDroneInfoTel(),
};

type HarnessOpts = {
  failTelemetryRpc?: string[];
};

const createHarness = async (
  urls: Awaited<ReturnType<typeof createUrls>>,
  opts: HarnessOpts = {},
) => {
  const telemetry = new jsmq.XPub();
  const rpc = new jsmq.Rep();
  const control = new jsmq.Sub();
  const sonar = new jsmq.XPub();

  const controls: { key: string; payload: any }[] = [];
  const rpcRequests: string[] = [];
  // Set of telemetry type names for which GetTelemetryReq should return an
  // empty (payload-less) response, forcing the client to fall back to SUB.
  const failTelemetryRpc = new Set(opts.failTelemetryRpc ?? []);

  let resolveTelemetrySubscription!: () => void;
  const telemetrySubscription = new Promise<void>((resolve) => {
    resolveTelemetrySubscription = resolve;
  });
  let resolveSonarSubscription!: () => void;
  const sonarSubscription = new Promise<void>((resolve) => {
    resolveSonarSubscription = resolve;
  });

  telemetry.bind(urls.subUrl);
  rpc.bind(urls.rpcUrl);
  control.bind(urls.pubUrl);
  sonar.bind(urls.sonarUrl);
  control.subscribe("");

  telemetry.once("message", () => {
    resolveTelemetrySubscription();
  });
  sonar.once("message", () => {
    resolveSonarSubscription();
  });

  rpc.on("message", (topic: Uint8Array, payload: Uint8Array) => {
    const key = topicName(topic);
    rpcRequests.push(key);

    if (key === "GetBatteryReq") {
      rpc.send([
        "blueye.protocol.GetBatteryRep",
        encodeMessage("GetBatteryRep", createBatteryRep()),
      ]);
      return;
    }

    if (key === "GetTelemetryReq") {
      const request = blueye.protocol.GetTelemetryReq.decode(payload);

      if (failTelemetryRpc.has(request.messageType)) {
        // Respond with an empty rep (no payload) so Zod validation fails
        rpc.send([
          "blueye.protocol.GetTelemetryRep",
          encodeMessage("GetTelemetryRep", {}),
        ]);
        return;
      }

      const factory = defaultTelemetryPayloads[request.messageType];
      const telPayload = factory ? factory() : {};

      rpc.send([
        "blueye.protocol.GetTelemetryRep",
        encodeMessage(
          "GetTelemetryRep",
          createGetTelemetryRep(request.messageType, telPayload),
        ),
      ]);
      return;
    }

    throw new Error(`Unexpected RPC request: ${key}`);
  });

  control.on("message", (topic: Uint8Array, payload: Uint8Array) => {
    const key = topicName(topic);
    controls.push({
      key,
      payload:
        key in blueye.protocol
          ? (blueye.protocol as any)[key].decode(payload)
          : payload,
    });
  });

  return {
    telemetry,
    rpc,
    control,
    sonar,
    controls,
    rpcRequests,
    async publishTelemetry(type: string, payload: any) {
      await telemetrySubscription;
      telemetry.send([`blueye.protocol.${type}`, encodeMessage(type, payload)]);
    },
    async publishSonarTelemetry(type: string, payload: any) {
      await sonarSubscription;
      sonar.send([`blueye.protocol.${type}`, encodeMessage(type, payload)]);
    },
    async close() {
      // ws@8's WebSocketServer.close() no longer terminates active client
      // connections (ws@7 did). Force-close them so the BlueyeClient sees
      // the disconnect and emits "lost".
      for (const sock of [telemetry, rpc, control, sonar]) {
        const wss = (sock as any).binds?.[0]?.server;
        if (wss?.clients) {
          for (const client of wss.clients as Set<{ terminate?: () => void }>) {
            client.terminate?.();
          }
        }
      }
      telemetry.close();
      rpc.close();
      control.close();
      sonar.close();
      // Allow the OS to release the ports before the next test binds
      await delay(50);
    },
  };
};

describe("BlueyeClient", () => {
  it("connects and exchanges request, telemetry, and control messages", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls);
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      expect(client.state).toBe("connected");

      const batteryRep = await client.sendRequest("GetBatteryReq");
      assertBattery(batteryRep!.battery);

      const batteryTel = await client.getTelemetry("BatteryTel");
      assertBattery(batteryTel.battery);

      const batteryTelemetryEvent = waitForEvent(client, "BatteryTel");
      await harness.publishTelemetry("BatteryTel", createBatteryTel());
      const [receivedTelemetry] = (await batteryTelemetryEvent) as any[];
      assertBattery(receivedTelemetry.battery);

      await client.sendControl("LightsCtrl", { lights: { value: 0.2 } });
      await delay(50);

      expect(harness.rpcRequests).toEqual([
        "GetTelemetryReq",
        "GetBatteryReq",
        "GetTelemetryReq",
      ]);
      expect(harness.controls.at(-1)?.key).toBe("LightsCtrl");
      expect(
        Math.abs(harness.controls.at(-1)?.payload.lights?.value - 0.2),
      ).toBeLessThan(1e-5);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("rejects outbound operations until connected", async () => {
    const client = new BlueyeClient();

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while disconnected/,
    );

    await expect(
      client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    ).rejects.toThrow(/cannot send pub while disconnected/);
  });

  it("stays connecting without a server and allows manual disconnect", async () => {
    const urls = await createUrls();
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 100,
    });

    client.connect();
    await delay(200);

    expect(client.state).toBe("connecting");

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while connecting/,
    );

    await expect(
      client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    ).rejects.toThrow(/cannot send pub while connecting/);

    client.disconnect();
    expect(client.state).toBe("disconnected");
  });

  it("returns to connecting and reconnects after the server returns", async () => {
    const urls = await createUrls();
    let harness = await createHarness(urls);
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");
      await delay(50); // let sonar detection RPC complete

      await harness.close();
      await waitForState(client, "connecting", 3_000);
      expect(client.state).toBe("connecting");

      harness = await createHarness(urls);
      await waitForState(client, "connected", 3_000);

      const batteryRep = await client.sendRequest("GetBatteryReq");
      assertBattery(batteryRep!.battery);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("stays connecting during repeated failures and stops after manual disconnect", async () => {
    const urls = await createUrls();
    let harness = await createHarness(urls);
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 100,
    });

    try {
      client.connect();
      await waitForState(client, "connected");
      await delay(50); // let sonar detection RPC complete

      await harness.close();
      await waitForState(client, "connecting", 3_000);
      await delay(200);

      expect(client.state).toBe("connecting");

      await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
        /cannot send rpc while connecting/,
      );

      await expect(
        client.sendControl("LightsCtrl", { lights: { value: 1 } }),
      ).rejects.toThrow(/cannot send pub while connecting/);

      client.disconnect();
      expect(client.state).toBe("disconnected");

      harness = await createHarness(urls);
      await delay(150);
      expect(client.state).toBe("disconnected");
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("detects sonar from DroneInfoTel and emits sonar telemetry", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls, {
      failTelemetryRpc: ["DroneInfoTel"],
    });
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      // Publish DroneInfoTel repeatedly until the sonar detection handler picks it up
      // (the handler's RPC must fail and fall back to SUB before it can receive this)
      const sonarConnected = waitForEvent(client, "sonar-connected", 5_000);
      const interval = setInterval(async () => {
        await harness.publishTelemetry("DroneInfoTel", createDroneInfoTel(13));
      }, 100);

      try {
        await sonarConnected;
      } finally {
        clearInterval(interval);
      }
      expect(client.state).toBe("connected");

      const [multibeam] = (await Promise.all([
        waitForEvent(client, "MultibeamPingTel"),
        harness.publishSonarTelemetry(
          "MultibeamPingTel",
          createMultibeamPingTel(),
        ),
      ])) as any[];

      expect(multibeam[0].ping?.deviceId).toBe(13);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("does not require sonar for connected state when no multibeam detected", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls);
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      // No DroneInfoTel published — global state is connected without sonar
      expect(client.state).toBe("connected");

      // RPC still works without sonar
      const batteryRep = await client.sendRequest("GetBatteryReq");
      assertBattery(batteryRep!.battery);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });
});

describe("waitForTelemetry", () => {
  it("resolves via RPC when telemetry is available", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls);
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      const result = await client.waitForTelemetry("BatteryTel");
      assertBattery(result.battery);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("falls back to SUB when RPC fails", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls, {
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      // Start waiting — RPC will fail, so it blocks on SUB
      const waiting = client.waitForTelemetry("BatteryTel", 2_000);

      // Publish telemetry over SUB after a short delay
      await delay(50);
      await harness.publishTelemetry("BatteryTel", createBatteryTel());

      const result = await waiting;
      assertBattery(result.battery);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("rejects on timeout", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls, {
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      await expect(client.waitForTelemetry("BatteryTel", 100)).rejects.toThrow(
        /timed out waiting for BatteryTel telemetry/,
      );
    } finally {
      client.disconnect();
      await harness.close();
    }
  });

  it("removes listener on timeout", async () => {
    const urls = await createUrls();
    const harness = await createHarness(urls, {
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = new BlueyeClient({
      ...urls,
      reconnectInterval: 50,
      timeout: 500,
    });

    try {
      client.connect();
      await waitForState(client, "connected");

      const before = client.listenerCount("BatteryTel");

      await expect(client.waitForTelemetry("BatteryTel", 100)).rejects.toThrow(
        /timed out/,
      );

      expect(client.listenerCount("BatteryTel")).toBe(before);
    } finally {
      client.disconnect();
      await harness.close();
    }
  });
});
