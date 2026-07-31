import { describe, expect, it } from "vitest";

import {
  decodeMessage,
  encodeMessage,
  isCtrl,
  isInProtocol,
  isRep,
  isReq,
  isTel,
  keyToTopic,
  protocolTypeOf,
  topicToKey,
} from "../src/protocol";

describe("protocol", () => {
  it("maps topics and typeUrls to protocol keys, from text or bytes", () => {
    expect(topicToKey("blueye.protocol.BatteryTel")).toBe("BatteryTel");
    expect(
      topicToKey(new TextEncoder().encode("blueye.protocol.GetBatteryRep")),
    ).toBe("GetBatteryRep");
    expect(topicToKey("type.googleapis.com/blueye.protocol.BatteryTel")).toBe(
      "BatteryTel",
    );
    expect(topicToKey("")).toBe("");
  });

  it("round-trips keys through keyToTopic and topicToKey", () => {
    expect(topicToKey(keyToTopic("BatteryTel"))).toBe("BatteryTel");
    expect(keyToTopic("LightsCtrl")).toBe("blueye.protocol.LightsCtrl");
  });

  it("classifies protocol keys by kind", () => {
    expect(protocolTypeOf("GetBatteryReq")).toBe("Req");
    expect(protocolTypeOf("GetBatteryRep")).toBe("Rep");
    expect(protocolTypeOf("BatteryTel")).toBe("Tel");
    expect(protocolTypeOf("LightsCtrl")).toBe("Ctrl");
  });

  it("guards keys against the protocol", () => {
    expect(isInProtocol("BatteryTel")).toBe(true);
    expect(isInProtocol("NotAThing")).toBe(false);

    expect(isReq("GetBatteryReq")).toBe(true);
    expect(isReq("BatteryTel")).toBe(false);

    expect(isRep("GetBatteryRep")).toBe(true);
    expect(isRep("GetBatteryReq")).toBe(false);

    expect(isTel("BatteryTel")).toBe(true);
    expect(isTel("LightsCtrl")).toBe(false);

    expect(isCtrl("LightsCtrl")).toBe(true);
    expect(isCtrl("BatteryTel")).toBe(false);
  });

  it("round-trips a message through encode and decode", () => {
    const encoded = encodeMessage("LightsCtrl", {
      lights: { value: 0.5 },
    });

    const decoded = decodeMessage("LightsCtrl", encoded);
    expect(decoded.lights?.value).toBeCloseTo(0.5, 5);
  });
});
