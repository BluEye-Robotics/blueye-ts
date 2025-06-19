import { LogLevels } from "consola";
import { BlueyeClient } from "./src/client";

const main = async () => {
  const client = new BlueyeClient(LogLevels.debug);

  const rep = await client.sendRequest("GetBatteryReq");
  const tel = await client.getTelemetry("BatteryTel");

  console.log("Rep:", rep);
  console.log("Tel:", tel);

  client.sub.on("BatteryTel", data => {
    console.log("Received BatteryTel:", data);
  });
};

main();
