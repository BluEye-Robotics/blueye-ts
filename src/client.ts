import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import { ConsolaInstance, createConsola, LogLevel, LogLevels } from "consola";
import { Emitter } from "strict-event-emitter";
import { responseSchema, telemetrySchema } from "./schema";

const WS_PUBSUB_URL = "ws://localhost:8765";
const WS_REQREP_URL = "ws://localhost:8766";

type Protocol = typeof blueye.protocol;

type ReqKeys = Extract<keyof Protocol, `${string}Req`>;
type Req = keyof Pick<Protocol, ReqKeys>;

type TelKeys = Extract<keyof Protocol, `${string}Tel`>;
type Tel = keyof Pick<Protocol, TelKeys>;

type ReqToRep<T extends Req> = T extends `${infer Prefix}Req`
  ? `${Prefix}Rep` extends keyof Protocol
    ? Protocol[`${Prefix}Rep`]
    : never
  : never;

type MsgHandler<T extends Req> = Protocol[T];
type CreateArgs<T extends Req> = Parameters<MsgHandler<T>["create"]>[0];
type DecodedOutput<T extends Req> = ReturnType<ReqToRep<T>["decode"]>;
type DecodedTelOutput<T extends Tel> = ReturnType<Protocol[T]["decode"]>;

type Events = {
  [K in Tel]: [DecodedTelOutput<K>];
};

const isInProtocol = (key: string): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

export class BlueyeClient {
  private wsPubSub: WebSocket;
  private wsReqRep: WebSocket;
  private isReqRepConnected = false;
  private logger: ConsolaInstance;

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
  }

  private async send(data: string): Promise<string> {
    while (!this.isReqRepConnected) {
      this.logger.debug("Waiting...");
      await new Promise(res => setTimeout(res, 50));
    }

    return await new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        cleanUp();
        resolve(event.data as string);
      };

      const onError = (error: Event) => {
        cleanUp();
        this.logger.error("[WS] Error:", error);
        reject(error);
      };

      const cleanUp = () => {
        this.wsReqRep.removeEventListener("message", onMessage);
        this.wsReqRep.removeEventListener("error", onError);
      };

      this.wsReqRep.addEventListener("message", onMessage);
      this.wsReqRep.addEventListener("error", onError);

      this.wsReqRep.send(data);
    });
  }

  async sendRequest<T extends Req>(req: T, opts: CreateArgs<T> = {}): Promise<DecodedOutput<T> | null> {
    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    const response = await this.send(
      JSON.stringify({
        key: `blueye.protocol.${req}`,
        data: Buffer.from(encoded).toString("base64")
      })
    );

    this.logger.debug("Response:", response);

    const { key, data } = responseSchema.parse(JSON.parse(response));

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
