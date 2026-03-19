import { blueye } from "@blueyerobotics/protocol-definitions";
import type { DecodedTelOutput } from "./client";

type DroneInfoTel = DecodedTelOutput<"DroneInfoTel">;
type MultibeamConfig = NonNullable<DecodedTelOutput<"MultibeamConfigTel">["config"]>;

const {
  MultibeamConfig_MaximumNumberOfBeams: Beams,
  MultibeamConfig_PingRate,
} = blueye.protocol;

export const MULTIBEAM_DEVICE_IDS = new Set([13, 16, 18, 20, 29, 30, 41, 42]);

export const MULTIBEAM_DEVICE_NAMES: Record<number, string> = {
  13: "Oculus M750D",
  16: "Gemini 720im",
  18: "Micron Gemini",
  20: "Gemini 720ik",
  29: "Oculus M1200D",
  30: "Oculus M3000D",
  41: "Oculus C550d",
  42: "Oculus M370s",
};

export interface SonarRangeInfo {
  minRange: number;
  maxRange: number;
}

export interface SonarDeviceInfo {
  name: string;
  hasDualFrequency: boolean;
  supportsGainBoost: boolean;
  lowFreq: SonarRangeInfo;
  highFreq: SonarRangeInfo;
  lowFrequencyHz: number;
  highFrequencyHz: number;
  validBeams: number[];
}

export const SONAR_DEVICE_INFO: Record<number, SonarDeviceInfo> = {
  16: {
    name: "Gemini 720im",
    hasDualFrequency: false,
    supportsGainBoost: false,
    lowFreq: { minRange: 0.2, maxRange: 50 },
    highFreq: { minRange: 0.2, maxRange: 50 },
    lowFrequencyHz: 720_000,
    highFrequencyHz: 0,
    validBeams: [Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_128],
  },
  18: {
    name: "Micron Gemini",
    hasDualFrequency: false,
    supportsGainBoost: false,
    lowFreq: { minRange: 1, maxRange: 50 },
    highFreq: { minRange: 1, maxRange: 50 },
    lowFrequencyHz: 720_000,
    highFrequencyHz: 0,
    validBeams: [Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_128],
  },
  20: {
    name: "Gemini 720ik",
    hasDualFrequency: false,
    supportsGainBoost: false,
    lowFreq: { minRange: 0.1, maxRange: 120 },
    highFreq: { minRange: 0.1, maxRange: 120 },
    lowFrequencyHz: 720_000,
    highFrequencyHz: 0,
    validBeams: [Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_512],
  },
  13: {
    name: "Oculus M750d",
    hasDualFrequency: true,
    supportsGainBoost: true,
    lowFreq: { minRange: 0.1, maxRange: 120 },
    highFreq: { minRange: 0.1, maxRange: 40 },
    lowFrequencyHz: 750_000,
    highFrequencyHz: 1_200_000,
    validBeams: [
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256,
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_512,
    ],
  },
  29: {
    name: "Oculus M1200d",
    hasDualFrequency: true,
    supportsGainBoost: true,
    lowFreq: { minRange: 0.1, maxRange: 40 },
    highFreq: { minRange: 0.1, maxRange: 10 },
    lowFrequencyHz: 1_200_000,
    highFrequencyHz: 2_100_000,
    validBeams: [
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256,
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_512,
    ],
  },
  30: {
    name: "Oculus M3000d",
    hasDualFrequency: true,
    supportsGainBoost: true,
    lowFreq: { minRange: 0.1, maxRange: 30 },
    highFreq: { minRange: 0.1, maxRange: 5 },
    lowFrequencyHz: 1_200_000,
    highFrequencyHz: 3_000_000,
    validBeams: [
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256,
      Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_512,
    ],
  },
  41: {
    name: "Oculus C550d",
    hasDualFrequency: true,
    supportsGainBoost: true,
    lowFreq: { minRange: 0.2, maxRange: 100 },
    highFreq: { minRange: 0.2, maxRange: 30 },
    lowFrequencyHz: 550_000,
    highFrequencyHz: 820_000,
    validBeams: [Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256],
  },
  42: {
    name: "Oculus M370s",
    hasDualFrequency: false,
    supportsGainBoost: true,
    lowFreq: { minRange: 0.2, maxRange: 200 },
    highFreq: { minRange: 0.2, maxRange: 200 },
    lowFrequencyHz: 375_000,
    highFrequencyHz: 0,
    validBeams: [Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256],
  },
};

const DEFAULT_VALID_BEAMS = [
  Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_128,
  Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_256,
  Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_512,
  Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_1024,
];

export function getRangeInfo(
  deviceId: number | undefined,
  frequencyMode: number | undefined,
): SonarRangeInfo {
  const info = deviceId ? SONAR_DEVICE_INFO[deviceId] : undefined;
  if (!info) return { minRange: 0.1, maxRange: 200 };
  const isHigh =
    frequencyMode ===
    blueye.protocol.MultibeamFrequencyMode.MULTIBEAM_FREQUENCY_MODE_HIGH_FREQUENCY;
  return isHigh ? info.highFreq : info.lowFreq;
}

export function getValidBeams(deviceId: number | undefined): number[] {
  return (
    (deviceId != null ? SONAR_DEVICE_INFO[deviceId]?.validBeams : undefined) ??
    DEFAULT_VALID_BEAMS
  );
}

export const DEFAULT_MULTIBEAM_CONFIG: MultibeamConfig = {
  frequencyMode:
    blueye.protocol.MultibeamFrequencyMode.MULTIBEAM_FREQUENCY_MODE_LOW_FREQUENCY,
  pingRate: MultibeamConfig_PingRate.PING_RATE_NORMAL,
  gammaCorrection: 0.5,
  gainAssist: true,
  gainBoost: false,
  maximumNumberOfBeams: Beams.MAXIMUM_NUMBER_OF_BEAMS_MAX_128,
  range: 10,
  gain: 0.5,
  salinity: 0,
  deviceId: blueye.protocol.GuestPortDeviceID.GUEST_PORT_DEVICE_ID_UNSPECIFIED,
  bandwidthLimit: 0,
};

export interface ConnectedMultibeam {
  deviceId: number;
  name: string;
}

export function getConnectedMultibeam(
  droneInfo: DroneInfoTel | null,
): ConnectedMultibeam | null {
  const gp = droneInfo?.droneInfo?.gp;
  if (!gp) return null;

  for (const gpKey of ["gp1", "gp2", "gp3"] as const) {
    const devices = gp[gpKey]?.deviceList?.devices ?? [];
    for (const device of devices) {
      const id = typeof device.deviceId === "number" ? device.deviceId : undefined;
      if (id != null && MULTIBEAM_DEVICE_IDS.has(id)) {
        return {
          deviceId: id,
          name: device.name || MULTIBEAM_DEVICE_NAMES[id] || "Multibeam Sonar",
        };
      }
    }
  }

  return null;
}
