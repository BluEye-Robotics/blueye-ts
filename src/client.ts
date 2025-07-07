import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import { ConsolaInstance, createConsola, LogLevel, LogLevels } from "consola";
import { Pub as ZMQPub, Req as ZMQRep, Sub as ZMQSub } from "jszmq";
import { Emitter } from "strict-event-emitter";
import z from "zod";
import { responseSchema, telemetrySchema } from "./schema";

const SUB_URL = "ws://192.168.1.101:9985";
const RPC_URL = "ws://192.168.1.101:9986";
const PUB_URL = "ws://192.168.1.101:9987";

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
export type CreateArgs<T extends Req | Ctrl> = Parameters<MsgHandler<T>["create"]>[0];
export type DecodedOutput<T extends Req> = ReturnType<ReqToRep<T>["decode"]>;
export type DecodedTelOutput<T extends Tel> = ReturnType<Protocol[T]["decode"]>;

export type Events = {
  [K in Tel]: [DecodedTelOutput<K>];
};

export const isInProtocol = (key: string): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

export class BlueyeClient extends Emitter<Events> {
  private sub: ZMQSub;
  private rpc: ZMQRep;
  private pub: ZMQPub;
  private logger: ConsolaInstance;

  constructor(public timeout = 2000, logLevel: LogLevel = LogLevels.info) {
    super();

    this.logger = createConsola({ level: logLevel, formatOptions: { colors: true, compact: false } });
    this.sub = new ZMQSub();
    this.rpc = new ZMQRep();
    this.pub = new ZMQPub();

    this.sub.subscribe("");
    this.sub.connect(SUB_URL);
    this.rpc.connect(RPC_URL);
    this.pub.connect(PUB_URL);

    // @ts-ignore
    this.sub.on("message", (topic, msg) => {
      const { key, data } = responseSchema.parse({ key: topic, data: msg });

      if (!isInProtocol(key) || !key.endsWith("Tel")) {
        this.logger.warn("[sub] unknown protocol:", key);
        return;
      }

      const protocol = blueye.protocol[key as Tel];
      const message = protocol.decode(data);

      this.logger.verbose("[sub] message:", key, message);
      this.emit(key as Tel, message as any);
    });
  }

  async sendRequest<T extends Req>(req: T, opts: CreateArgs<T> = {}): Promise<DecodedOutput<T> | null> {
    if (!isInProtocol(req) || !req.endsWith("Req")) {
      throw new Error(`[rpc] unknown protocol: ${req}`);
    }

    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    const { key, data } = await Promise.race([
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("[rpc] request timed out")), this.timeout)),
      new Promise<z.infer<typeof responseSchema>>(resolve => {
        // @ts-ignore
        this.rpc.once("message", (topic, msg) => {
          resolve({ key: topic.toString().split(".").at(-1), data: msg });
        });

        this.rpc.send([Buffer.from(`blueye.protocol.${req}`), Buffer.from(encoded)]);
      })
    ]);

    if (key === "Empty") {
      return null;
    }

    if (!isInProtocol(key) || !key.endsWith("Rep")) {
      throw new Error(`[rpc] unknown response protocol: ${key}`);
    }

    const rep = blueye.protocol[key as T] as ReqToRep<T>;
    const result = rep.decode(data) as DecodedOutput<T>;

    this.logger.debug("[rpc] decoded:", result);

    return result;
  }

  async getTelemetry<T extends Tel>(type: T): Promise<DecodedTelOutput<T>> {
    const response = await this.sendRequest("GetTelemetryReq", { messageType: type });
    const { payload } = telemetrySchema.parse(response);
    const { typeUrl, value } = payload;

    if (!isInProtocol(typeUrl) || !typeUrl.endsWith("Tel")) {
      throw new Error(`[rpc] unknown telemetry typeUrl: ${typeUrl}`);
    }

    const result = (blueye.protocol[typeUrl] as Protocol[T]).decode(value) as DecodedTelOutput<T>;

    this.logger.debug("[rpc] result:", result);

    return result;
  }

  async sendControl<T extends Ctrl>(ctrl: T, opts: CreateArgs<T> = {}) {
    if (!isInProtocol(ctrl) || !ctrl.endsWith("Ctrl")) {
      throw new Error(`[pub] unknown protocol: ${ctrl}`);
    }

    const protocol = blueye.protocol[ctrl];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    this.logger.debug("[pub] sending control:", ctrl, message);
    this.pub.send([Buffer.from(`blueye.protocol.${ctrl}`), Buffer.from(encoded)]);
  }
}
