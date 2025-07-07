# blueye-ts

A TypeScript client for interacting with Blueye underwater drones.

## Installation

```bash
npm install @blueyerobotics/blueye-ts
```

## Usage

```ts
import { BlueyeClient } from "@blueyerobotics/blueye-ts";

const client = new BlueyeClient();

// request battery information
const batteryRep = await client.sendRequest("GetBatteryReq");
console.log("batteryRep:", batteryRep);

// get latest battery telemetry
const batteryTel = await client.getTelemetry("BatteryTel");
console.log("batteryTel:", batteryTel);

// subscribe to battery telemetry updates
client.on("BatteryTel", data => {
  console.log("received BatteryTel:", data);
});
```
