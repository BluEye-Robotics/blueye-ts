// biome-ignore-all lint/suspicious/noExplicitAny: test harness uses dynamic protocol indexing
// biome-ignore-all lint/style/noNonNullAssertion: harness always responds, so sendRequest cannot return null in these tests
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { blueye } from "@blueyerobotics/protocol-definitions";
import { describe, expect, it } from "vitest";

import { BlueyeClient } from "../src/client";
import { InMemoryTransport } from "../src/in-memory-transport";

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
  sonarEndpoint?: boolean;
};

const createHarness = (opts: HarnessOpts = {}) => {
  const transport = new InMemoryTransport();
  const urls = {
    subUrl: "mem://sub",
    rpcUrl: "mem://rpc",
    pubUrl: "mem://pub",
    sonarUrl: "mem://sonar",
  };

  const controls: { key: string; payload: any }[] = [];
  const rpcRequests: string[] = [];
  // Set of telemetry type names for which GetTelemetryReq should return an
  // empty (payload-less) response, forcing the client to fall back to SUB.
  const failTelemetryRpc = new Set(opts.failTelemetryRpc ?? []);

  const rpcHandler = (
    frames: Uint8Array[],
    reply: (frames: (Uint8Array | string)[]) => void,
  ) => {
    const [topic, payload] = frames;
    const key = topicName(topic);
    rpcRequests.push(key);

    if (key === "GetBatteryReq") {
      reply([
        "blueye.protocol.GetBatteryRep",
        encodeMessage("GetBatteryRep", createBatteryRep()),
      ]);
      return;
    }

    if (key === "GetTelemetryReq") {
      const request = blueye.protocol.GetTelemetryReq.decode(payload);

      if (failTelemetryRpc.has(request.messageType)) {
        // Respond with an empty rep (no payload) so Zod validation fails
        reply([
          "blueye.protocol.GetTelemetryRep",
          encodeMessage("GetTelemetryRep", {}),
        ]);
        return;
      }

      const factory = defaultTelemetryPayloads[request.messageType];
      const telPayload = factory ? factory() : {};

      reply([
        "blueye.protocol.GetTelemetryRep",
        encodeMessage(
          "GetTelemetryRep",
          createGetTelemetryRep(request.messageType, telPayload),
        ),
      ]);
      return;
    }

    throw new Error(`Unexpected RPC request: ${key}`);
  };

  const controlHandler = (frames: Uint8Array[]) => {
    const [topic, payload] = frames;
    const key = topicName(topic);
    controls.push({
      key,
      payload:
        key in blueye.protocol
          ? (blueye.protocol as any)[key].decode(payload)
          : payload,
    });
  };

  const open = () => {
    transport.listen(urls.subUrl);
    transport.listen(urls.rpcUrl).onMessage(rpcHandler);
    transport.listen(urls.pubUrl).onMessage(controlHandler);
    if (opts.sonarEndpoint !== false) {
      transport.listen(urls.sonarUrl);
    }
  };

  const openSonar = () => {
    transport.listen(urls.sonarUrl);
  };

  open();

  return {
    transport,
    urls,
    controls,
    rpcRequests,
    publishTelemetry(type: string, payload: any) {
      transport
        .endpoint(urls.subUrl)
        ?.send([`blueye.protocol.${type}`, encodeMessage(type, payload)]);
    },
    publishSonarTelemetry(type: string, payload: any) {
      transport
        .endpoint(urls.sonarUrl)
        ?.send([`blueye.protocol.${type}`, encodeMessage(type, payload)]);
    },
    close() {
      transport.closeAll();
    },
    // Simulate a tether/radio drop: the link dies but no close event arrives
    sever() {
      transport.severAll();
    },
    open,
    openSonar,
  };
};

const createClient = (
  harness: ReturnType<typeof createHarness>,
  options: Record<string, unknown> = {},
) =>
  new BlueyeClient({
    ...harness.urls,
    transport: harness.transport,
    timeout: 500,
    ...options,
  });

describe("BlueyeClient", () => {
  it("connects and exchanges request, telemetry, and control messages", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    expect(client.state).toBe("connected");

    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep!.battery);

    const batteryTel = await client.getTelemetry("BatteryTel");
    assertBattery(batteryTel.battery);

    const batteryTelemetryEvent = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    const [receivedTelemetry] = (await batteryTelemetryEvent) as any[];
    assertBattery(receivedTelemetry.battery);

    await client.sendControl("LightsCtrl", { lights: { value: 0.2 } });
    await delay(10);

    expect(harness.rpcRequests).toEqual([
      "GetTelemetryReq",
      "GetBatteryReq",
      "GetTelemetryReq",
    ]);
    expect(harness.controls.at(-1)?.key).toBe("LightsCtrl");
    expect(
      Math.abs(harness.controls.at(-1)?.payload.lights?.value - 0.2),
    ).toBeLessThan(1e-5);

    client.disconnect();
  });

  it("rejects outbound operations until connected", async () => {
    const client = new BlueyeClient({ transport: new InMemoryTransport() });

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while disconnected/,
    );

    await expect(
      client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    ).rejects.toThrow(/cannot send pub while disconnected/);
  });

  it("stays connecting without a server and allows manual disconnect", async () => {
    // A transport with no listening endpoints — sockets never become ready
    const client = new BlueyeClient({
      transport: new InMemoryTransport(),
      timeout: 100,
    });

    client.connect();
    await delay(50);

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
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");
    await delay(50); // let sonar detection RPC complete

    harness.close();
    await waitForState(client, "connecting");
    expect(client.state).toBe("connecting");

    harness.open();
    await waitForState(client, "connected");

    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep!.battery);

    client.disconnect();
  });

  it("stays connecting during server loss and stops after manual disconnect", async () => {
    const harness = createHarness();
    const client = createClient(harness, { timeout: 100 });

    client.connect();
    await waitForState(client, "connected");
    await delay(50); // let sonar detection RPC complete

    harness.close();
    await waitForState(client, "connecting");

    expect(client.state).toBe("connecting");

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while connecting/,
    );

    await expect(
      client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    ).rejects.toThrow(/cannot send pub while connecting/);

    client.disconnect();
    expect(client.state).toBe("disconnected");

    harness.open();
    await delay(50);
    expect(client.state).toBe("disconnected");
  });

  it("detects sonar from DroneInfoTel and emits sonar telemetry", async () => {
    const harness = createHarness({
      failTelemetryRpc: ["DroneInfoTel"],
    });
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    // Detection listens for DroneInfoTel permanently — a single SUB publish
    // is enough, no matter where the detection handler is in its RPC attempt
    const sonarConnected = waitForEvent(client, "sonar-connected");
    harness.publishTelemetry("DroneInfoTel", createDroneInfoTel(13));

    await sonarConnected;
    expect(client.state).toBe("connected");

    const [multibeam] = (await Promise.all([
      waitForEvent(client, "MultibeamPingTel"),
      harness.publishSonarTelemetry(
        "MultibeamPingTel",
        createMultibeamPingTel(),
      ),
    ])) as any[];

    expect(multibeam[0].ping?.deviceId).toBe(13);

    client.disconnect();
  });

  it("does not require sonar for connected state when no multibeam detected", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    // No DroneInfoTel published — global state is connected without sonar
    expect(client.state).toBe("connected");

    // RPC still works without sonar
    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep!.battery);

    client.disconnect();
  });

  it("emits edge-triggered state events — one per actual change", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    const events: string[] = [];
    client.on("connecting", () => events.push("connecting"));
    client.on("connected", () => events.push("connected"));
    client.on("disconnected", () => events.push("disconnected"));

    client.connect();
    await waitForState(client, "connected");
    expect(events).toEqual(["connecting", "connected"]);

    client.disconnect();
    expect(events).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("requires sonar once detected: state and sends reflect the sonar socket", async () => {
    // Sonar endpoint intentionally absent so the bring-up window stays open
    const harness = createHarness({ sonarEndpoint: false });
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    const sonarConnecting = waitForEvent(client, "sonar-connecting");
    harness.publishTelemetry("DroneInfoTel", createDroneInfoTel(13));
    await sonarConnecting;

    // Sonar detected but its socket is not ready — state regresses with an event
    expect(client.state).toBe("connecting");

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while connecting/,
    );

    // Once the sonar endpoint appears, the client completes the connection
    harness.openSonar();
    await waitForState(client, "connected");

    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep!.battery);

    client.disconnect();
  });

  it("reconnects cleanly after a session in which sonar was detected", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    const sonarConnected = waitForEvent(client, "sonar-connected");
    harness.publishTelemetry("DroneInfoTel", createDroneInfoTel(13));
    await sonarConnected;
    expect(client.state).toBe("connected");

    client.disconnect();
    expect(client.state).toBe("disconnected");

    // Sonar detection resets per connection: reconnect must reach "connected"
    // without the sonar socket until a sonar is detected again
    client.connect();
    await waitForState(client, "connected");

    const sonarReconnected = waitForEvent(client, "sonar-connected");
    harness.publishTelemetry("DroneInfoTel", createDroneInfoTel(13));
    await sonarReconnected;
    expect(client.state).toBe("connected");

    client.disconnect();
  });

  it("close() disconnects and releases the sockets permanently", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    client.close();
    expect(client.state).toBe("disconnected");

    await expect(client.sendRequest("GetBatteryReq")).rejects.toThrow(
      /cannot send rpc while disconnected/,
    );

    // Closed sockets never re-attach, even with the server up
    harness.open();
    await delay(50);
    expect(client.state).toBe("disconnected");
  });
});

describe("telemetry staleness watchdog", () => {
  it("converts a silent link failure into connecting, then recovers", async () => {
    const harness = createHarness();
    const client = createClient(harness, { stalenessTimeout: 200 });

    client.connect();
    await waitForState(client, "connected");

    // Arm the watchdog: telemetry must flow at least once
    const firstTel = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    await firstTel;

    // Tether drop: the link dies silently — no close event reaches the sockets
    harness.sever();
    await waitForEvent(client, "connecting");
    expect(client.state).toBe("connecting");

    // Link returns: the normal reconnect machinery restores the session
    harness.open();
    await waitForState(client, "connected");

    const telAgain = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    await telAgain;

    client.close();
  });

  it("does not flap after a close-based outage longer than the window", async () => {
    const harness = createHarness();
    const client = createClient(harness, { stalenessTimeout: 150 });

    client.connect();
    await waitForState(client, "connected");

    // Arm the watchdog with real telemetry
    const firstTel = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    await firstTel;

    // Close-based loss (drone reboot): sockets get a proper close event
    harness.close();
    await waitForState(client, "connecting");

    // Stay down for well over the staleness window
    await delay(400);

    // Server returns; the pre-outage timestamp must not be judged against
    // the new connection before its first telemetry message arrives
    harness.open();
    await waitForState(client, "connected");

    let spuriousDrops = 0;
    client.on("connecting", () => {
      spuriousDrops++;
    });

    await delay(500);
    expect(spuriousDrops).toBe(0);
    expect(client.state).toBe("connected");

    // Telemetry re-arms the watchdog on the new connection as usual
    const telAgain = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    await telAgain;

    client.close();
  });

  it("does nothing when disabled via stalenessTimeout: 0", async () => {
    const harness = createHarness();
    const client = createClient(harness, { stalenessTimeout: 0 });

    client.connect();
    await waitForState(client, "connected");

    const firstTel = waitForEvent(client, "BatteryTel");
    harness.publishTelemetry("BatteryTel", createBatteryTel());
    await firstTel;

    let wentConnecting = 0;
    client.on("connecting", () => {
      wentConnecting++;
    });

    harness.sever();
    await delay(600);

    expect(wentConnecting).toBe(0);
    expect(client.state).toBe("connected");

    client.close();
  });

  it("never fires before the first telemetry message arrives", async () => {
    const harness = createHarness();
    const client = createClient(harness, { stalenessTimeout: 150 });

    client.connect();
    await waitForState(client, "connected");

    // No SUB telemetry is ever published — the watchdog must stay disarmed
    let wentConnecting = 0;
    client.on("connecting", () => {
      wentConnecting++;
    });

    await delay(600);

    expect(wentConnecting).toBe(0);
    expect(client.state).toBe("connected");

    client.close();
  });
});

describe("waitForTelemetry", () => {
  it("resolves via RPC when telemetry is available", async () => {
    const harness = createHarness();
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    const result = await client.waitForTelemetry("BatteryTel");
    assertBattery(result.battery);

    client.disconnect();
  });

  it("falls back to SUB when RPC fails", async () => {
    const harness = createHarness({
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    // Start waiting — RPC will fail, so it blocks on SUB
    const waiting = client.waitForTelemetry("BatteryTel", 2_000);

    // Publish telemetry over SUB after a short delay
    await delay(50);
    harness.publishTelemetry("BatteryTel", createBatteryTel());

    const result = await waiting;
    assertBattery(result.battery);

    client.disconnect();
  });

  it("rejects on timeout", async () => {
    const harness = createHarness({
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    await expect(client.waitForTelemetry("BatteryTel", 100)).rejects.toThrow(
      /timed out waiting for BatteryTel telemetry/,
    );

    client.disconnect();
  });

  it("removes listener on timeout", async () => {
    const harness = createHarness({
      failTelemetryRpc: ["BatteryTel"],
    });
    const client = createClient(harness);

    client.connect();
    await waitForState(client, "connected");

    const before = client.listenerCount("BatteryTel");

    await expect(client.waitForTelemetry("BatteryTel", 100)).rejects.toThrow(
      /timed out/,
    );

    expect(client.listenerCount("BatteryTel")).toBe(before);

    client.disconnect();
  });
});
