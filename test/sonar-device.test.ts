import { describe, expect, it } from "vitest";

import type { DecodedTelOutput } from "../src/protocol";
import {
  detectSonar,
  hasSonarEndpoint,
  MULTIBEAM_DEVICE_IDS,
} from "../src/sonar-device";

type GuestPortSlot = "gp1" | "gp2" | "gp3";

const droneInfoTel = (
  version: string | undefined,
  devicesByPort: Partial<Record<GuestPortSlot, number[]>> = {},
) =>
  ({
    droneInfo: {
      blunuxVersion: version,
      gp: Object.fromEntries(
        Object.entries(devicesByPort).map(([port, ids]) => [
          port,
          {
            deviceList: {
              devices: ids.map((deviceId) => ({ deviceId, name: "" })),
            },
          },
        ]),
      ),
    },
  }) as unknown as DecodedTelOutput<"DroneInfoTel">;

describe("hasSonarEndpoint", () => {
  it("accepts 4.7.0 and newer", () => {
    expect(hasSonarEndpoint("4.7.0")).toBe(true);
    expect(hasSonarEndpoint("4.7.1")).toBe(true);
    expect(hasSonarEndpoint("4.10.0")).toBe(true);
    expect(hasSonarEndpoint("5.0.0")).toBe(true);
  });

  it("rejects versions before 4.7.0", () => {
    expect(hasSonarEndpoint("4.6.9")).toBe(false);
    expect(hasSonarEndpoint("4.0.0")).toBe(false);
    expect(hasSonarEndpoint("3.12.1")).toBe(false);
  });

  it("accepts dev builds regardless of base version", () => {
    expect(hasSonarEndpoint("4.6.0-dev")).toBe(true);
    expect(hasSonarEndpoint("3.2.1-dev")).toBe(true);
  });

  it("rejects garbage and empty versions", () => {
    expect(hasSonarEndpoint("")).toBe(false);
    expect(hasSonarEndpoint("not-a-version")).toBe(false);
  });
});

describe("detectSonar", () => {
  it("detects a multibeam device on any guest port", () => {
    for (const port of ["gp1", "gp2", "gp3"] as const) {
      const detection = detectSonar(droneInfoTel("4.7.0", { [port]: [13] }));
      expect(detection).toEqual({ detected: true, deviceId: 13 });
    }
  });

  it("detects every known multibeam device ID", () => {
    for (const deviceId of MULTIBEAM_DEVICE_IDS) {
      const detection = detectSonar(droneInfoTel("4.7.0", { gp1: [deviceId] }));
      expect(detection).toEqual({ detected: true, deviceId });
    }
  });

  it("finds the multibeam among unrelated devices", () => {
    const detection = detectSonar(
      droneInfoTel("4.7.0", { gp1: [1, 2], gp2: [3, 16] }),
    );
    expect(detection).toEqual({ detected: true, deviceId: 16 });
  });

  it("reports no device when the lists have no multibeam", () => {
    expect(detectSonar(droneInfoTel("4.7.0", { gp1: [1, 2] }))).toEqual({
      detected: false,
      reason: "no-multibeam-device",
    });
    expect(detectSonar(droneInfoTel("4.7.0"))).toEqual({
      detected: false,
      reason: "no-multibeam-device",
    });
  });

  it("reports incompatible firmware before looking at devices", () => {
    expect(detectSonar(droneInfoTel("4.6.0", { gp1: [13] }))).toEqual({
      detected: false,
      reason: "incompatible-firmware",
      version: "4.6.0",
    });
    expect(detectSonar(droneInfoTel(undefined, { gp1: [13] }))).toEqual({
      detected: false,
      reason: "incompatible-firmware",
      version: undefined,
    });
  });
});
