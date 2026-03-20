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

`client.sonarState` reflects the sonar socket independently. If the client loses one or more sockets after being connected, the derived state moves back to `connecting`. `sendRequest()` and `sendControl()` reject unless the client is in the `connected` state.

## Sonar support

`BlueyeClient` connects the sonar websocket endpoint at `ws://192.168.1.101:9988` when a supported multibeam device is detected in a `DroneInfoTel` message.

- On `connect()`, the sonar socket subscribes but only connects when a known multibeam device ID is found in the guest-port device list.
- Once detected, the sonar socket connects and the global `connected` state requires it to be ready.
- Sonar telemetry such as `MultibeamPingTel`, `MultibeamConfigTel`, and `MultibeamDiscoveryTel` is emitted through the same typed event interface as other telemetry messages.
