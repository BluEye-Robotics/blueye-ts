import { blueye, google } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import { z } from "zod";

const WS_PUBSUB_URL = "ws://localhost:8765";
const WS_REQREP_URL = "ws://localhost:8766";

type Protocol = typeof blueye.protocol;
type ReqKeys = Extract<keyof Protocol, `${string}Req`>;
type ReqsOnly = Pick<Protocol, ReqKeys>;
type Req = keyof ReqsOnly;

type MsgHandler<T extends Req> = Protocol[T];
type CreateArgs<T extends Req> = Parameters<MsgHandler<T>["create"]>[0];

type ReqToRep<T extends Req> = T extends `${infer Prefix}Req`
  ? `${Prefix}Rep` extends keyof Protocol
    ? Protocol[`${Prefix}Rep`]
    : never
  : never;

const responseSchema = z.object({
  key: z.string().transform(val => val.split(".").at(-1)!),
  data: z
    .string()
    .base64()
    .transform(val => Buffer.from(val, "base64"))
});

const payloadSchema = z.object({
  payload: z.object({
    typeUrl: z.string().transform(val => val.split(".").at(-1)!),
    value: z.instanceof(Buffer)
  })
});

const isInProtocol = (key: string): key is keyof typeof blueye.protocol => {
  return key in blueye.protocol;
};

const isInGoogleProtocol = (key: string): key is keyof typeof google.protobuf => {
  return key in google.protobuf;
};

class BlueyeClient {
  private wsPubSub: WebSocket;
  private wsReqRep: WebSocket;
  private isReqRepConnected = false;

  constructor() {
    this.wsPubSub = new WebSocket(WS_PUBSUB_URL);
    this.wsReqRep = new WebSocket(WS_REQREP_URL);

    this.wsPubSub.addEventListener("open", () => {
      console.log("[WS] PubSub connected");
    });

    this.wsReqRep.addEventListener("open", () => {
      this.isReqRepConnected = true;
      console.log("[WS] ReqRep connected");
    });
  }

  private async send(data: string): Promise<string> {
    while (!this.isReqRepConnected) {
      await new Promise(res => setTimeout(res, 250));
    }

    return await new Promise((resolve, reject) => {
      this.wsReqRep.addEventListener("message", event => {
        resolve(event.data as string);
      });

      this.wsReqRep.addEventListener("error", error => {
        console.error("[WS] Error:", error);
        reject(error);
      });

      this.wsReqRep.send(data);
    });
  }

  async sendReqRep<T extends Req>(req: T, opts: CreateArgs<T>) {
    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    const response = await this.send(
      JSON.stringify({
        key: `blueye.protocol.${req}`,
        data: Buffer.from(encoded).toString("base64")
      })
    );

    console.log("Response: ", response);

    const { key, data } = responseSchema.parse(JSON.parse(response));
    const rep = blueye.protocol[key as T] as ReqToRep<T>;
    const decoded = rep.decode(data);
    const { payload } = payloadSchema.parse(decoded);
    const { typeUrl, value } = payload;
    let result;

    if (isInProtocol(typeUrl)) {
      // @ts-ignore
      result = blueye.protocol[typeUrl].decode(value);
    } else if (isInGoogleProtocol(typeUrl)) {
      result = google.protobuf[typeUrl].decode(value);
    } else {
      throw new Error("Unknown typeUrl");
    }

    console.log("Result: ", result);
    return result as ReturnType<ReqToRep<T>["decode"]>;
  }
}

const main = async () => {
  const client = new BlueyeClient();
  const rep = await client.sendReqRep("GetTelemetryReq", { messageType: "GuestPortCurrentTel" });
};

main();
