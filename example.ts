import { BlueyeClient } from "./index";

const main = async () => {
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
};

main();
