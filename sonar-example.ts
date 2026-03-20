import { BlueyeClient } from "./index";

const main = async () => {
  const client = new BlueyeClient();

  client.on("connected", (socket) => {
    console.log(`${socket} connected`);
  });

  client.on("connecting", (socket) => {
    console.log(`${socket} connecting...`);
  });

  client.on("disconnected", (socket) => {
    console.log(`${socket} disconnected`);
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
