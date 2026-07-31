import { blueye } from "@blueyerobotics/protocol-definitions";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { Gunzip } from "fflate";
import {
  type DecodedOutput,
  decodeMessage,
  isInProtocol,
  type Protocol,
  type ProtocolKey,
  type ProtocolType,
  protocolTypeOf,
  topicToKey,
} from "./protocol";

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
 * @returns A promise that resolves to the decompressed data as a Uint8Array.
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

  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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

    if (msg.payload == null) {
      console.warn("Missing payload in BinlogRecord");
      continue;
    }

    const key = topicToKey(msg.payload.typeUrl) as ProtocolKey;

    if (!isInProtocol(key)) {
      console.warn(`Unknown protocol key: ${key}`);
      continue;
    }

    const data = decodeMessage(key, msg.payload.value);
    let innerData: object | undefined;

    if (key === "GetTelemetryRep") {
      const telRep = data as DecodedOutput<"GetTelemetryReq">;

      if (telRep.payload == null) {
        console.warn("Missing inner payload in GetTelemetryRep");
        continue;
      }

      const innerKey = topicToKey(telRep.payload.typeUrl) as ProtocolKey;

      if (!isInProtocol(innerKey)) {
        console.warn(`Unknown inner protocol key: ${innerKey}`);
        continue;
      }

      innerData = decodeMessage(innerKey, telRep.payload.value);
    }

    const type: ProtocolType = protocolTypeOf(key);

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
/**
 * Parse a single varint-prefixed BinlogRecord from raw (uncompressed) bytes.
 * Used for streaming playback where individual frames are fetched via HTTP Range requests.
 * @param bytes Raw bytes containing a single varint-length-prefixed BinlogRecord.
 * @returns The parsed message, or null if the record is not a known protocol type.
 */
export const parseFrame = (bytes: Uint8Array): Message | null => {
  const messages = parseFrames(bytes);
  return messages.length > 0 ? messages[0] : null;
};

/**
 * Parse multiple contiguous varint-prefixed BinlogRecords from raw (uncompressed) bytes.
 * Used for streaming playback where frame batches are fetched via HTTP Range requests.
 * @param bytes Raw bytes containing one or more varint-length-prefixed BinlogRecords.
 * @returns An array of parsed messages.
 */
export const parseFrames = (bytes: Uint8Array): Message[] => {
  return parseMessages(bytes, false);
};

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
