import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import { ConsolaInstance, createConsola, LogLevel, LogLevels } from "consola";
import { Pub as ZMQPub, Req as ZMQRep, Sub as ZMQSub } from "jszmq";
import { Emitter } from "strict-event-emitter";
import z from "zod";
import { AsyncQueue } from "./async-queue";
import { responseSchema, telemetrySchema } from "./schema";

const DEFAULT_SUB_URL = "ws://192.168.1.101:9985";
const DEFAULT_RPC_URL = "ws://192.168.1.101:9986";
const DEFAULT_PUB_URL = "ws://192.168.1.101:9987";

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

type State = "connecting" | "connected" | "disconnected";

export type Events = {
  [K in State]: [];
} & {
  [K in Tel]: [DecodedTelOutput<K>];
};

export const isInProtocol = (
  key: string,
): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

type Options = Partial<{
  subUrl: string;
  rpcUrl: string;
  pubUrl: string;
  timeout: number;
  logLevel: LogLevel;
  autoConnect: boolean;
}>;

export class BlueyeClient extends Emitter<Events> {
  public state: State = "disconnected";
  public timeout: number;

  private subUrl: string;
  private rpcUrl: string;
  private pubUrl: string;

  private sub: ZMQSub;
  private rpc: ZMQRep;
  private pub: ZMQPub;
  private queue: AsyncQueue;
  private logger: ConsolaInstance;

  constructor({
    subUrl = DEFAULT_SUB_URL,
    rpcUrl = DEFAULT_RPC_URL,
    pubUrl = DEFAULT_PUB_URL,
    timeout = 2000,
    logLevel = LogLevels.info,
    autoConnect = false,
  }: Options = {}) {
    super();

    this.timeout = timeout;

    this.subUrl = subUrl;
    this.rpcUrl = rpcUrl;
    this.pubUrl = pubUrl;

    this.sub = new ZMQSub();
    this.rpc = new ZMQRep();
    this.pub = new ZMQPub();

    this.queue = new AsyncQueue();
    this.logger = createConsola({
      level: logLevel,
      formatOptions: { colors: true, compact: false },
    });

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

    if (autoConnect) {
      this.connect();
    }
  }

  private updateState(newState: State) {
    this.state = newState;
    this.logger.info(`[client] ${newState}`);
    this.emit(newState);
  }

  connect() {
    if (this.state === "connected") {
      this.logger.warn("[client] already connected");
      return;
    }

    if (this.state === "connecting") {
      this.logger.warn("[client] already connecting");
      return;
    }

    this.updateState("connecting");
    this.sub.subscribe("");
    this.sub.connect(this.subUrl);
    this.rpc.connect(this.rpcUrl);
    this.pub.connect(this.pubUrl);
    this.updateState("connected");
  }

  disconnect() {
    if (this.state === "disconnected") {
      this.logger.warn("[client] already disconnected");
      return;
    }

    if (this.state === "connecting") {
      this.logger.warn("[client] cannot disconnect while connecting");
      return;
    }

    this.sub.unsubscribe("");
    this.sub.disconnect(this.subUrl);
    this.rpc.disconnect(this.rpcUrl);
    this.pub.disconnect(this.pubUrl);
    this.updateState("disconnected");
  }

  async sendRequest<T extends Req>(
    req: T,
    opts: CreateArgs<T> = {},
  ): Promise<DecodedOutput<T> | null> {
    if (!isInProtocol(req) || !req.endsWith("Req")) {
      throw new Error(`[rpc] unknown protocol: ${req}`);
    }

    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    const request = () => {
      return new Promise<z.infer<typeof responseSchema>>((resolve) => {
        // @ts-ignore
        this.rpc.once("message", (topic, msg) => {
          resolve({ key: topic.toString().split(".").at(-1), data: msg });
        });

        this.rpc.send([
          Buffer.from(`blueye.protocol.${req}`),
          Buffer.from(encoded),
        ]);
      });
    };

    const { key, data } = await Promise.race([
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("[rpc] request timed out")),
          this.timeout,
        ),
      ),
      this.queue.enqueue(request),
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
    const response = await this.sendRequest("GetTelemetryReq", {
      messageType: type,
    });
    const { payload } = telemetrySchema.parse(response);
    const { typeUrl, value } = payload;

    if (!isInProtocol(typeUrl) || !typeUrl.endsWith("Tel")) {
      throw new Error(`[rpc] unknown telemetry typeUrl: ${typeUrl}`);
    }

    const result = (blueye.protocol[typeUrl] as Protocol[T]).decode(
      value,
    ) as DecodedTelOutput<T>;

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
    this.pub.send([
      Buffer.from(`blueye.protocol.${ctrl}`),
      Buffer.from(encoded),
    ]);
  }
}
