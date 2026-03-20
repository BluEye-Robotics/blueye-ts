import { BlueyeClient } from "./index";

const main = async () => {
  const client = new BlueyeClient();

  client.on("connected", () => {
    console.log("client connected");
  });

  client.on("connecting", () => {
    console.log("client connecting...");
  });

  client.on("disconnected", () => {
    console.log("client disconnected");
  });

  client.on("sonar-connected", () => {
    console.log("sonar connected");
  });

  client.on("sonar-connecting", () => {
    console.log("sonar connecting...");
  });

  client.on("MultibeamDiscoveryTel", (data) => {
    console.log("received MultibeamDiscoveryTel:", data.discovery);
  });

  client.on("MultibeamConfigTel", (data) => {
    console.log("received MultibeamConfigTel:", data.config);
  });

  client.on("MultibeamPingTel", (data) => {
    const ping = data.ping;
    if (!ping) {
      return;
    }

    console.log("received MultibeamPingTel:", {
      deviceId: ping.deviceId,
      range: ping.range,
      beams: ping.numberOfBeams,
      ranges: ping.numberOfRanges,
    });
  });

  client.connect();
};

main();
