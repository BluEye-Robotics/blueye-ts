import * as semver from "semver";
import type { DecodedTelOutput } from "./protocol";

export const MULTIBEAM_DEVICE_IDS = [13, 16, 18, 20, 29, 30, 41, 42];

const GUEST_PORTS = ["gp1", "gp2", "gp3"] as const;

export type SonarDetection =
  | { detected: true; deviceId: number }
  | {
      detected: false;
      reason: "incompatible-firmware";
      version: string | undefined;
    }
  | { detected: false; reason: "no-multibeam-device" };

/**
 * The sonar telemetry endpoint exists on Blunux >= 4.7.0; "-dev" builds are
 * assumed to be newer than any release.
 */
export const hasSonarEndpoint = (version: string): boolean => {
  const coercedVersion = semver.coerce(version);
  return coercedVersion
    ? semver.satisfies(coercedVersion, ">=4.7.0") || version.endsWith("-dev")
    : false;
};

/**
 * Decide from a DroneInfoTel whether a multibeam sonar is connected and
 * reachable: the firmware must expose the sonar endpoint and a known
 * multibeam device ID must be present in one of the guest-port device lists.
 * Pure — no sockets, no side effects.
 */
export const detectSonar = (
  msg: DecodedTelOutput<"DroneInfoTel">,
): SonarDetection => {
  const version = msg.droneInfo?.blunuxVersion;

  if (!hasSonarEndpoint(version ?? "")) {
    return { detected: false, reason: "incompatible-firmware", version };
  }

  for (const port of GUEST_PORTS) {
    const devices = msg.droneInfo?.gp?.[port]?.deviceList?.devices ?? [];
    for (const device of devices) {
      if (MULTIBEAM_DEVICE_IDS.includes(device.deviceId)) {
        return { detected: true, deviceId: device.deviceId };
      }
    }
  }

  return { detected: false, reason: "no-multibeam-device" };
};
