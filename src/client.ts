import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import { ConsolaInstance, createConsola, LogLevel, LogLevels } from "consola";
import { Emitter } from "strict-event-emitter";
import { v4 as uuidv4 } from "uuid";
import z from "zod";
import { responseSchema, telemetrySchema } from "./schema";

const WS_PUBSUB_URL = "ws://localhost:8765";
const WS_REQREP_URL = "ws://localhost:8766";

export type Protocol = typeof blueye.protocol;

export type ReqKeys = Extract<keyof Protocol, `${string}Req`>;
export type Req = keyof Pick<Protocol, ReqKeys>;

export type TelKeys = Extract<keyof Protocol, `${string}Tel`>;
export type Tel = keyof Pick<Protocol, TelKeys>;

export type ReqToRep<T extends Req> = T extends `${infer Prefix}Req`
  ? `${Prefix}Rep` extends keyof Protocol
    ? Protocol[`${Prefix}Rep`]
    : never
  : never;

export type MsgHandler<T extends Req> = Protocol[T];
export type CreateArgs<T extends Req> = Parameters<MsgHandler<T>["create"]>[0];
export type DecodedOutput<T extends Req> = ReturnType<ReqToRep<T>["decode"]>;
export type DecodedTelOutput<T extends Tel> = ReturnType<Protocol[T]["decode"]>;

export type Events = {
  [K in Tel]: [DecodedTelOutput<K>];
};

export const isInProtocol = (key: string): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

export class BlueyeClient {
  private wsPubSub: WebSocket;
  private wsReqRep: WebSocket;
  private isReqRepConnected = false;
  private logger: ConsolaInstance;
  private pendingRequests: Map<string, (response: z.infer<typeof responseSchema>) => void> = new Map();

  sub = new Emitter<Events>();

  constructor(logLevel: LogLevel = LogLevels.info) {
    this.logger = createConsola({ level: logLevel, formatOptions: { colors: true, compact: false } });
    this.wsPubSub = new WebSocket(WS_PUBSUB_URL);
    this.wsReqRep = new WebSocket(WS_REQREP_URL);

    this.wsPubSub.addEventListener("open", () => {
      this.logger.info("[WS] PubSub connected");
    });

    this.wsReqRep.addEventListener("open", () => {
      this.isReqRepConnected = true;
      this.logger.info("[WS] ReqRep connected");
    });

    this.wsPubSub.addEventListener("message", event => {
      const { key, data } = responseSchema.parse(JSON.parse(event.data));
      const protocol = blueye.protocol[key as Tel];
      const message = protocol.decode(data);

      this.logger.verbose("[WS] PubSub message:", key, message);
      this.sub.emit(key as Tel, message as any);
    });

    this.wsReqRep.addEventListener("message", event => {
      this.logger.debug("Response:", event.data);

      const { id, key, data } = responseSchema.parse(JSON.parse(event.data));

      if (!id) throw new Error("Response id is missing");

      this.pendingRequests.get(id)?.({ key, data });
    });
  }

  async sendRequest<T extends Req>(req: T, opts: CreateArgs<T> = {}): Promise<DecodedOutput<T> | null> {
    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    while (!this.isReqRepConnected) {
      this.logger.debug("Waiting...");
      await new Promise(res => setTimeout(res, 50));
    }

    const id = uuidv4();

    const { key, data } = await Promise.race([
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Request timed out")), 2000)),
      new Promise<z.infer<typeof responseSchema>>(resolve => {
        const request = JSON.stringify({
          id,
          key: `blueye.protocol.${req}`,
          data: Buffer.from(encoded).toString("base64")
        });

        this.pendingRequests.set(id, resolve);
        this.wsReqRep.send(request);
      })
    ]);

    this.pendingRequests.delete(id);

    if (key === "Empty") {
      return null;
    }

    const rep = blueye.protocol[key as T] as ReqToRep<T>;
    const result = rep.decode(data) as DecodedOutput<T>;

    this.logger.debug("Decoded:", result);

    return result;
  }

  async getTelemetry<T extends Tel>(type: T): Promise<DecodedTelOutput<T>> {
    const response = await this.sendRequest("GetTelemetryReq", { messageType: type });
    const { payload } = telemetrySchema.parse(response);
    const { typeUrl, value } = payload;

    this.logger.debug(typeUrl);

    if (isInProtocol(typeUrl)) {
      const result = (blueye.protocol[typeUrl] as Protocol[T]).decode(value) as DecodedTelOutput<T>;

      this.logger.debug("Result:", result);

      return result;
    } else {
      throw new Error("Unknown typeUrl");
    }
  }
}
