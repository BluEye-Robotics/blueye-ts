const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const { blueye } = require("@blueyerobotics/protocol-definitions");
const { BlueyeClient } = require("../dist/index.js");
const jsmq = require("jszmq");

const BATTERY = {
  level: 85,
  voltage: 18.67,
  temperature: 7.5,
};

const assertBattery = (actual) => {
  assert.equal(actual.level, BATTERY.level);
  assert.equal(actual.temperature, BATTERY.temperature);
  assert.ok(Math.abs(actual.voltage - BATTERY.voltage) < 1e-5);
};

const waitForEvent = async (emitter, eventName, timeout = 2_000) => {
  return Promise.race([
    once(emitter, eventName),
    delay(timeout).then(() => {
      throw new Error(`Timed out waiting for "${eventName}"`);
    }),
  ]);
};

const getFreePort = async () => {
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

const topicName = (topic) => topic.toString().split(".").at(-1);

const encodeMessage = (key, message = {}) => {
  const protocol = blueye.protocol[key];
  const created = protocol.create(message);
  return Buffer.from(protocol.encode(created).finish());
};

const createBatteryRep = () => ({
  battery: { ...BATTERY },
});

const createBatteryTel = () => ({
  battery: { ...BATTERY },
});

const createGetTelemetryRep = (type, payload) => ({
  payload: {
    typeUrl: `blueye.protocol.${type}`,
    value: blueye.protocol[type].encode(blueye.protocol[type].create(payload)).finish(),
  },
});

const createDroneInfoTel = (deviceId = null) => ({
  droneInfo: {
    gp:
      deviceId == null
        ? undefined
        : {
            gp1: {
              deviceList: {
                devices: [
                  {
                    deviceId,
                    name: "",
                  },
                ],
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

const createHarness = async (urls, options = {}) => {
  const { connectedMultibeamDeviceId = null } = options;
  const telemetry = new jsmq.XPub();
  const rpc = new jsmq.Rep();
  const control = new jsmq.Sub();
  const sonar = new jsmq.XPub();

  const controls = [];
  const rpcRequests = [];
  let resolveTelemetrySubscription;
  const telemetrySubscription = new Promise((resolve) => {
    resolveTelemetrySubscription = resolve;
  });
  let resolveSonarSubscription;
  const sonarSubscription = new Promise((resolve) => {
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

  rpc.on("message", (topic, payload) => {
    const key = topicName(topic);
    rpcRequests.push(key);

    if (key === "GetBatteryReq") {
      rpc.send([
        Buffer.from("blueye.protocol.GetBatteryRep"),
        encodeMessage("GetBatteryRep", createBatteryRep()),
      ]);
      return;
    }

    if (key === "GetTelemetryReq") {
      const request = blueye.protocol.GetTelemetryReq.decode(payload);
      const response =
        request.messageType === "DroneInfoTel"
          ? createDroneInfoTel(connectedMultibeamDeviceId)
          : createBatteryTel();
      rpc.send([
        Buffer.from("blueye.protocol.GetTelemetryRep"),
        encodeMessage("GetTelemetryRep", createGetTelemetryRep(request.messageType, response)),
      ]);
      return;
    }

    throw new Error(`Unexpected RPC request: ${key}`);
  });

  control.on("message", (topic, payload) => {
    const key = topicName(topic);
    controls.push({
      key,
      payload:
        key in blueye.protocol
          ? blueye.protocol[key].decode(payload)
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
    async publishTelemetry(type, payload) {
      await telemetrySubscription;
      telemetry.send([
        Buffer.from(`blueye.protocol.${type}`),
        encodeMessage(type, payload),
      ]);
    },
    async publishSonarTelemetry(type, payload) {
      await sonarSubscription;
      sonar.send([
        Buffer.from(`blueye.protocol.${type}`),
        encodeMessage(type, payload),
      ]);
    },
    close() {
      telemetry.close();
      rpc.close();
      control.close();
      sonar.close();
    },
  };
};

test("BlueyeClient connects and exchanges request, telemetry, and control messages", async () => {
  const urls = await createUrls();
  const harness = await createHarness(urls);
  const client = new BlueyeClient({
    ...urls,
    reconnectInterval: 50,
    timeout: 500,
    autoConnectSonar: false,
  });

  try {
    const connected = waitForEvent(client, "connected");

    client.connect();
    await connected;

    assert.equal(client.state, "connected");

    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep.battery);

    const batteryTel = await client.getTelemetry("BatteryTel");
    assertBattery(batteryTel.battery);

    const batteryTelemetryEvent = waitForEvent(client, "BatteryTel");
    await harness.publishTelemetry("BatteryTel", createBatteryTel());
    const [receivedTelemetry] = await batteryTelemetryEvent;
    assertBattery(receivedTelemetry.battery);

    await client.sendControl("LightsCtrl", { lights: { value: 0.2 } });
    await delay(50);

    assert.deepEqual(harness.rpcRequests, ["GetBatteryReq", "GetTelemetryReq"]);
    assert.equal(harness.controls.at(-1)?.key, "LightsCtrl");
    assert.ok(
      Math.abs(harness.controls.at(-1)?.payload.lights?.value - 0.2) < 1e-5,
    );
  } finally {
    client.disconnect();
    harness.close();
  }
});

test("BlueyeClient rejects outbound operations until connected", async () => {
  const client = new BlueyeClient();

  await assert.rejects(
    () => client.sendRequest("GetBatteryReq"),
    /cannot send request while disconnected/,
  );

  await assert.rejects(
    () => client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    /cannot send control while disconnected/,
  );
});

test("BlueyeClient stays connecting without a server and allows manual disconnect", async () => {
  const urls = await createUrls();
  const client = new BlueyeClient({
    ...urls,
    reconnectInterval: 50,
    timeout: 100,
    autoConnectSonar: false,
  });

  client.connect();
  await delay(200);

  assert.equal(client.state, "connecting");

  await assert.rejects(
    () => client.sendRequest("GetBatteryReq"),
    /cannot send request while connecting/,
  );

  await assert.rejects(
    () => client.sendControl("LightsCtrl", { lights: { value: 1 } }),
    /cannot send control while connecting/,
  );

  client.disconnect();
  assert.equal(client.state, "disconnected");
});

test("BlueyeClient enters reconnecting and reconnects after the server returns", async () => {
  const urls = await createUrls();
  let harness = await createHarness(urls);
  const client = new BlueyeClient({
    ...urls,
    reconnectInterval: 50,
    timeout: 500,
    autoConnectSonar: false,
  });

  try {
    client.connect();
    await waitForEvent(client, "connected");

    harness.close();
    await waitForEvent(client, "reconnecting", 3_000);
    assert.equal(client.state, "reconnecting");

    harness = await createHarness(urls);
    await waitForEvent(client, "connected", 3_000);

    const batteryRep = await client.sendRequest("GetBatteryReq");
    assertBattery(batteryRep.battery);
  } finally {
    client.disconnect();
    harness.close();
  }
});

test("BlueyeClient stays reconnecting during repeated failures and stops after manual disconnect", async () => {
  const urls = await createUrls();
  let harness = await createHarness(urls);
  const client = new BlueyeClient({
    ...urls,
    reconnectInterval: 50,
    timeout: 100,
    autoConnectSonar: false,
  });

  try {
    client.connect();
    await waitForEvent(client, "connected");

    harness.close();
    await waitForEvent(client, "reconnecting", 3_000);
    await delay(200);

    assert.equal(client.state, "reconnecting");

    await assert.rejects(
      () => client.sendRequest("GetBatteryReq"),
      /cannot send request while reconnecting/,
    );

    await assert.rejects(
      () => client.sendControl("LightsCtrl", { lights: { value: 1 } }),
      /cannot send control while reconnecting/,
    );

    client.disconnect();
    assert.equal(client.state, "disconnected");

    harness = await createHarness(urls);
    await delay(150);
    assert.equal(client.state, "disconnected");
  } finally {
    client.disconnect();
    harness.close();
  }
});

test("BlueyeClient detects a connected sonar and emits sonar telemetry", async () => {
  const urls = await createUrls();
  const harness = await createHarness(urls, { connectedMultibeamDeviceId: 13 });
  const client = new BlueyeClient({
    ...urls,
    reconnectInterval: 50,
    timeout: 500,
  });

  try {
    client.connect();
    await waitForEvent(client, "connected");
    await waitForEvent(client, "sonarConnected", 3_000);

    assert.equal(client.sonarState, "connected");
    assert.deepEqual(client.connectedMultibeam, {
      deviceId: 13,
      name: "Oculus M750D",
    });

    const [multibeam] = await Promise.all([
      waitForEvent(client, "MultibeamPingTel"),
      harness.publishSonarTelemetry("MultibeamPingTel", createMultibeamPingTel()),
    ]);

    assert.equal(multibeam[0].ping?.deviceId, 13);
  } finally {
    client.disconnect();
    harness.close();
  }
});
