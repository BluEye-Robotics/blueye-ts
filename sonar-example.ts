import { BlueyeClient, SONAR_DEVICE_INFO } from "./index";

const main = async () => {
  const client = new BlueyeClient();

  client.on("connected", async () => {
    try {
      console.log("client connected");

      const multibeam = await client.getConnectedMultibeam();
      if (!multibeam) {
        console.log("no supported multibeam detected");
        return;
      }

      console.log("connected multibeam:", multibeam);
      console.log(
        "device capabilities:",
        SONAR_DEVICE_INFO[multibeam.deviceId] ?? "unknown",
      );
    } catch (error) {
      console.error("Error:", error);
    }
  });

  client.on("reconnecting", () => {
    console.log("client reconnecting...");
  });

  client.on("disconnected", () => {
    console.log("client disconnected");
  });

  client.on("sonarConnecting", () => {
    console.log("sonar connecting...");
  });

  client.on("sonarConnected", () => {
    console.log("sonar connected");
  });

  client.on("sonarReconnecting", () => {
    console.log("sonar reconnecting...");
  });

  client.on("sonarDisconnected", () => {
    console.log("sonar disconnected");
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
