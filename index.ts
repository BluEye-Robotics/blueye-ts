import { LogLevels } from "consola";
import { BlueyeClient } from "./src/client";

const main = async () => {
  const client = new BlueyeClient(LogLevels.debug);
  const rep = await client.sendReqRep("GetBatteryReq");
  const tel = await client.reqTel("BatteryTel");

  console.log("Rep: ", rep);
  console.log("Tel: ", tel);
};

main();
