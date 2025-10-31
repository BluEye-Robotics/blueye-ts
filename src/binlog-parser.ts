import { blueye } from "@blueyerobotics/protocol-definitions";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { Buffer } from "buffer";
import { Gunzip } from "fflate";
import {
  type DecodedOutput,
  isInProtocol,
  type Protocol,
  type ProtocolKey,
  type ProtocolType,
} from "./client";

export type Message = {
  [K in ProtocolKey]: {
    monotonicTime: number;
    time: number;
    type: ProtocolType;
    key: K;
    data: ReturnType<Protocol[K]["decode"]>;
    innerData?: object;
  };
}[ProtocolKey];

/**
 * Parse a binlog file from raw (gzipped) data into structured messages..
 * @param rawData The raw binary data of the binlog file (gzip format).
 * @param fixTimes Fix the message times based on the last message's monotonic and unix timestamps. Useful for ensuring the times are in sync.
 * @returns A promise that resolves to an array of parsed messages.
 */
export const parse = async (rawData: Blob, fixTimes = true) => {
  const decompressed = await decompress(rawData);
  const messages = parseMessages(decompressed, fixTimes);
  return messages;
};

/**
 * Decompress the gzipped binlog data (.bez).
 * @param rawData The compressed binary data to decompress (gzip format).
 * @returns A promise that resolves to the decompressed data as a Buffer.
 */
export const decompress = async (rawData: Blob) => {
  const gunzip = new Gunzip();
  const blobReader = rawData.stream().getReader();
  const chunks: Uint8Array[] = [];

  gunzip.ondata = (chunk) => {
    chunks.push(chunk);
  };

  while (true) {
    const { done, value } = await blobReader.read();
    if (done) {
      try {
        gunzip.push(new Uint8Array(0), true);
      } catch (err) {
        console.error("Error pushing end-of-stream marker:", err);
      }
      break;
    }
    gunzip.push(value);
  }

  return Buffer.concat(chunks);
};

/**
 * Parse the decompressed binlog data into structured messages.
 * @param decompressed The gunzipped binlog data.
 * @param fixTimes Fix the message times based on the last message's monotonic and unix timestamps. Useful for ensuring the times are in sync.
 * @returns An array of parsed messages with their timestamps, types, keys, and data.
 */
export const parseMessages = (decompressed: Uint8Array, fixTimes = true) => {
  const reader = new BinaryReader(decompressed);
  let messages: Message[] = [];

  while (reader.pos < reader.len) {
    const length = reader.uint32();
    const start = reader.pos;
    const end = start + length;

    if (end > reader.len) {
      console.error("Unexpected EOF while reading message bytes");
      break;
    }

    const msgBytes = decompressed.buffer.slice(start, end);
    reader.pos = end;

    const msg = blueye.protocol.BinlogRecord.decode(
      new Uint8Array(msgBytes),
      length,
    );

    const key = msg.payload?.typeUrl.split(".").at(-1) as
      | ProtocolKey
      | undefined;

    if (!key || !isInProtocol(key)) {
      console.warn(`Unknown protocol key: ${key}`);
      continue;
    }

    if (msg.payload == null) {
      console.warn(`Missing payload for key: ${key}`);
      continue;
    }

    const data = blueye.protocol[key].decode(msg.payload.value);
    let innerData: object | undefined;

    if (key === "GetTelemetryRep") {
      const telRep = data as DecodedOutput<"GetTelemetryReq">;
      const innerKey = telRep.payload?.typeUrl.split(".").at(-1) as
        | ProtocolKey
        | undefined;

      if (!innerKey || !isInProtocol(innerKey)) {
        console.warn(`Unknown inner protocol key: ${innerKey}`);
        continue;
      }

      innerData = telRep.payload
        ? blueye.protocol[innerKey].decode(telRep.payload.value)
        : undefined;
    }

    let type: ProtocolType = "Tel";

    if (key.endsWith("Ctrl")) type = "Ctrl";
    else if (key.endsWith("Rep")) type = "Rep";
    else if (key.endsWith("Req")) type = "Req";

    messages.push({
      monotonicTime: msg.clockMonotonic?.getTime() ?? 0,
      time: msg.unixTimestamp?.getTime() ?? 0,
      type,
      key,
      data,
      innerData,
    } as Message);
  }

  if (fixTimes) {
    messages = fixMessageTimes(messages);
  }

  return messages;
};

/**
 * Fix the message times based on the last message's monotonic and unix timestamps.
 * @param messages The messages to fix the times for.
 * @returns The messages with corrected times.
 */
export const fixMessageTimes = (messages: Message[]) => {
  if (messages.length === 0) return messages;

  const last = messages.at(-1);
  if (!last) return messages;

  const ssbLast = last.monotonicTime;
  const unixLast = last.time;

  for (const message of messages) {
    const delta = ssbLast - message.monotonicTime;
    message.time = unixLast - delta;
  }

  return messages;
};
