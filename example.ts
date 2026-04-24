import { BlueyeClient } from "./index";

const main = async () => {
  const client = new BlueyeClient();

  client.on("connected", async () => {
    try {
      // request battery information
      const batteryRep = await client.sendRequest("GetBatteryReq");
      console.log("batteryRep:", batteryRep);

      // get latest battery telemetry
      const batteryTel = await client.getTelemetry("BatteryTel");
      console.log("batteryTel:", batteryTel);
    } catch {
      // swallow request/telemetry errors and continue with the control demo
    }

    // send a control message to change the light intensity to 0.1
    console.log("setting light intensity to 0.1 for 1 second...");
    await client.sendControl("LightsCtrl", { lights: { value: 0.1 } });

    setTimeout(async () => {
      console.log("setting light intensity back to 0...");
      await client.sendControl("LightsCtrl", { lights: { value: 0 } });
    }, 1000);
  });

  // subscribe to battery telemetry updates
  client.on("BatteryTel", (data) => {
    console.log("received BatteryTel:", data);
  });

  client.connect();
};

main();
