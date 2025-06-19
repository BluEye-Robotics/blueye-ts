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

const rep = await client.sendRequest("GetBatteryReq");
const tel = await client.getTelemetry("BatteryTel");

console.log("Rep:", rep);
console.log("Tel:", tel);

client.sub.on("BatteryTel", data => {
  console.log("Received BatteryTel:", data);
});
```
