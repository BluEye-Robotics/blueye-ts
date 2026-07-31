# blueye-ts

A TypeScript package for interacting with Blueye underwater drones and parsing binlog files.

## Installation

```bash
npm install @blueyerobotics/blueye-ts
```

## Usage

```ts
import { BlueyeClient } from "@blueyerobotics/blueye-ts";

const client = new BlueyeClient();

client.on("connected", async () => {
  // request battery information
  const batteryRep = await client.sendRequest("GetBatteryReq");
  console.log("batteryRep:", batteryRep);

  // get latest battery telemetry
  const batteryTel = await client.getTelemetry("BatteryTel");
  console.log("batteryTel:", batteryTel);

  // send a control message to change the light intensity to 1
  await client.sendControl("LightsCtrl", { lights: { value: 1 } });
});

// subscribe to battery telemetry updates
client.on("BatteryTel", data => {
  console.log("received BatteryTel:", data);
});

client.connect();
```

## Connection states

`BlueyeClient` manages four sockets: `sub`, `rpc`, `pub`, and `sonar`. Global state events (`connecting`, `connected`, `disconnected`) are emitted when the derived state changes. Per-socket events use the `${socket}-${state}` format (e.g. `sonar-connected`, `rpc-connecting`):

```ts
client.on("connected", () => {
  console.log("all required sockets ready");
});

client.on("sonar-connected", () => {
  console.log("sonar socket ready");
});
```

The derived `client.state` reflects the aggregate of the core sockets (`sub`, `rpc`, `pub`). If a multibeam sonar is detected via `DroneInfoTel`, the sonar socket is also required for `connected`.

- `disconnected`: `connect()` has not been called.
- `connecting`: one or more required sockets are not yet ready.
- `connected`: all required sockets are ready — safe to call `sendRequest()`, `getTelemetry()`, and `sendControl()`.

All state events — global and per-socket — are edge-triggered: they fire exactly once per actual change. If the client loses one or more sockets after being connected, the derived state moves back to `connecting` (with a `connecting` event). `sendRequest()` and `sendControl()` reject unless the client is in the `connected` state.

## Transports

`BlueyeClient` talks to its sockets through a small transport interface. The default adapter uses [jszmq](https://github.com/BluEye-Robotics/jszmq) over WebSockets; an in-memory adapter ships alongside it for tests, so application code using `BlueyeClient` can be exercised without a drone or any network:

```ts
import { BlueyeClient, InMemoryTransport } from "@blueyerobotics/blueye-ts";

const transport = new InMemoryTransport();
const rpc = transport.listen("mem://rpc");
rpc.onMessage(([topic, payload], reply) => {
  // inspect the request, reply([topic, encoded]) as the drone would
});
transport.listen("mem://sub");
transport.listen("mem://pub");
transport.listen("mem://sonar");

const client = new BlueyeClient({
  subUrl: "mem://sub",
  rpcUrl: "mem://rpc",
  pubUrl: "mem://pub",
  sonarUrl: "mem://sonar",
  transport,
});
```

When you are done with a client, call `client.close()` to release the underlying sockets permanently; a closed client cannot be reused.

## Sonar support

`BlueyeClient` connects the sonar websocket endpoint at `ws://192.168.1.101:9988` when a supported multibeam device is detected in a `DroneInfoTel` message.

- On `connect()`, the sonar socket subscribes but only connects when a known multibeam device ID is found in the guest-port device list. Detection inspects every `DroneInfoTel` — one is requested over RPC when the connection comes up, and any later `DroneInfoTel` arriving over SUB is also considered.
- Once detected, the sonar socket connects and the global `connected` state requires it to be ready. Detection resets on `disconnect()`; the next connection starts without requiring sonar until it is detected again.
- Sonar telemetry such as `MultibeamPingTel`, `MultibeamConfigTel`, and `MultibeamDiscoveryTel` is emitted through the same typed event interface as other telemetry messages.
