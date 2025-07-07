import { BlueyeClient } from "./index";

const main = async () => {
  const client = new BlueyeClient();

  const rep = await client.sendRequest("GetBatteryReq");
  const tel = await client.getTelemetry("BatteryTel");

  console.log("Rep:", rep);
  console.log("Tel:", tel);

  client.on("BatteryTel", data => {
    console.log("Received BatteryTel:", data);
  });
};

main();
