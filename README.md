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

`BlueyeClient` emits state events and exposes the current state on `client.state`.

- `disconnected`: the client is idle and no connection attempt is in progress.
- `connecting`: `connect()` has been called, but not all three sockets (`sub`, `rpc`, and `pub`) are ready yet.
- `connected`: all required sockets are ready, and it is safe to call `sendRequest()`, `getTelemetry()`, and `sendControl()`.
- `reconnecting`: the client was previously connected, then lost one or more sockets and is waiting for them to recover.

`sendRequest()` and `sendControl()` reject unless the client is in the `connected` state. A typical usage pattern is to wait for the `connected` event before sending messages, and optionally listen for `reconnecting` if you want to surface temporary transport loss in your application.

## Sonar support

`BlueyeClient` can also manage the optional sonar websocket endpoint at `ws://192.168.1.101:9988`.

- When the main client reaches `connected`, it requests `DroneInfoTel` and inspects the guest-port device list.
- If a supported multibeam sonar is present, the client automatically connects the sonar socket and exposes its state through `client.sonarState`.
- Sonar state changes are emitted as `sonarConnecting`, `sonarConnected`, `sonarReconnecting`, and `sonarDisconnected`.
- The detected device is exposed as `client.connectedMultibeam`, and you can refresh detection manually with `await client.getConnectedMultibeam()` or `await client.refreshSonarConnection()`.
- Sonar telemetry such as `MultibeamPingTel`, `MultibeamConfigTel`, and `MultibeamDiscoveryTel` is emitted through the same typed event interface as other telemetry messages.
