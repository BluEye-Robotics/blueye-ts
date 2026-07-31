import { blueye } from "@blueyerobotics/protocol-definitions";

export type Protocol = typeof blueye.protocol;
export type ProtocolType = "Req" | "Rep" | "Tel" | "Ctrl";
export type ProtocolKey = Extract<keyof Protocol, `${string}${ProtocolType}`>;

export type Req = keyof Pick<Protocol, Extract<ProtocolKey, `${string}Req`>>;
export type Rep = keyof Pick<Protocol, Extract<ProtocolKey, `${string}Rep`>>;
export type Tel = keyof Pick<Protocol, Extract<ProtocolKey, `${string}Tel`>>;
export type Ctrl = keyof Pick<Protocol, Extract<ProtocolKey, `${string}Ctrl`>>;

export type ReqToRep<T extends Req> = T extends `${infer Prefix}Req`
  ? `${Prefix}Rep` extends ProtocolKey
    ? Protocol[`${Prefix}Rep`]
    : never
  : never;

export type MsgHandler<T extends Req | Ctrl> = Protocol[T];
export type CreateArgs<T extends Req | Ctrl> = Parameters<
  MsgHandler<T>["create"]
>[0];
export type DecodedOutput<T extends Req> = ReturnType<ReqToRep<T>["decode"]>;
export type DecodedTelOutput<T extends Tel> = ReturnType<Protocol[T]["decode"]>;
export type DecodedMessage<K extends ProtocolKey> = ReturnType<
  Protocol[K]["decode"]
>;

const utf8Decoder = new TextDecoder();

export const isInProtocol = (
  key: string,
): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

export const isReq = (key: string): key is Req =>
  isInProtocol(key) && key.endsWith("Req");
export const isRep = (key: string): key is Rep =>
  isInProtocol(key) && key.endsWith("Rep");
export const isTel = (key: string): key is Tel =>
  isInProtocol(key) && key.endsWith("Tel");
export const isCtrl = (key: string): key is Ctrl =>
  isInProtocol(key) && key.endsWith("Ctrl");

/**
 * Extract the protocol key from a fully-qualified topic or typeUrl —
 * "blueye.protocol.BatteryTel" (as text or bytes) becomes "BatteryTel".
 */
export const topicToKey = (topic: Uint8Array | string): string => {
  const text = typeof topic === "string" ? topic : utf8Decoder.decode(topic);
  return text.split(".").at(-1) ?? "";
};

/** The inverse of topicToKey: "BatteryTel" becomes "blueye.protocol.BatteryTel". */
export const keyToTopic = (key: ProtocolKey): string =>
  `blueye.protocol.${key}`;

export const protocolTypeOf = (key: ProtocolKey): ProtocolType => {
  if (key.endsWith("Ctrl")) return "Ctrl";
  if (key.endsWith("Rep")) return "Rep";
  if (key.endsWith("Req")) return "Req";
  return "Tel";
};

export const encodeMessage = <T extends Req | Ctrl>(
  key: T,
  opts: CreateArgs<T>,
): Uint8Array => {
  const codec = blueye.protocol[key];
  const message = codec.create(opts);
  // The union of all message codecs collapses each encode parameter to never;
  // `message` came from the same codec's create, so the call is sound.
  return codec.encode(message as never).finish();
};

export const decodeMessage = <K extends ProtocolKey>(
  key: K,
  data: Uint8Array,
): DecodedMessage<K> => {
  return blueye.protocol[key].decode(data) as DecodedMessage<K>;
};
