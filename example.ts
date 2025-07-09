import { BlueyeClient } from "./index";

const main = async () => {
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
};

main();
