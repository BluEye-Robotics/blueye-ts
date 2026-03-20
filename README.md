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

client.on("connected", async (socket) => {
  if (socket !== "rpc") return;

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

`BlueyeClient` manages four sockets: `sub`, `rpc`, `pub`, and `sonar`. State events (`connecting`, `connected`, `disconnected`) carry the socket name as an argument, so you can react to individual socket changes:

```ts
client.on("connected", (socket) => {
  console.log(`${socket} connected`);
});
```

The derived `client.state` reflects the aggregate of the three core sockets (`sub`, `rpc`, `pub`):

- `disconnected`: `connect()` has not been called.
- `connecting`: one or more core sockets are not yet ready.
- `connected`: all three core sockets are ready — safe to call `sendRequest()`, `getTelemetry()`, and `sendControl()`.

`client.sonarState` reflects the sonar socket independently. `connect()` and `disconnect()` manage all four sockets together.

If the client loses one or more sockets after being connected, the derived state moves back to `connecting` until all required sockets are ready again. `sendRequest()` and `sendControl()` reject unless the client is in the `connected` state.

## Sonar support

`BlueyeClient` connects the sonar websocket endpoint at `ws://192.168.1.101:9988` as part of `connect()`.

- Sonar telemetry such as `MultibeamPingTel`, `MultibeamConfigTel`, and `MultibeamDiscoveryTel` is emitted through the same typed event interface as other telemetry messages.
