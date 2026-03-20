import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import {
  type ConsolaInstance,
  createConsola,
  type LogLevel,
  LogLevels,
} from "consola";
import { Pub as ZMQPub, Req as ZMQRep, Sub as ZMQSub } from "jszmq";
import { Emitter } from "strict-event-emitter";
import type z from "zod";
import { AsyncQueue } from "./async-queue";
import { responseSchema, telemetrySchema } from "./schema";

const DEFAULT_SUB_URL = "ws://192.168.1.101:9985";
const DEFAULT_RPC_URL = "ws://192.168.1.101:9986";
const DEFAULT_PUB_URL = "ws://192.168.1.101:9987";
const DEFAULT_SONAR_URL = "ws://192.168.1.101:9988";

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
type SocketName = "sub" | "rpc" | "pub";
type ConnectionLifecycleSocket = {
  on(event: "ready" | "lost", listener: () => void): unknown;
};
type SonarStateEvent =
  | "sonarConnecting"
  | "sonarConnected"
  | "sonarDisconnected";

const SONAR_STATE_EVENTS: Record<State, SonarStateEvent> = {
  connecting: "sonarConnecting",
  connected: "sonarConnected",
  disconnected: "sonarDisconnected",
};

export type Events = {
  [K in State]: [];
} & {
  [K in SonarStateEvent]: [];
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
  sonarUrl: string;
  timeout: number;
  reconnectInterval: number;
  logLevel: LogLevel;
  autoConnect: boolean;
  autoConnectSonar: boolean;
}>;

export class BlueyeClient extends Emitter<Events> {
  public state: State = "disconnected";
  public sonarState: State = "disconnected";
  public timeout: number;
  public reconnectInterval: number;

  private subUrl: string;
  private rpcUrl: string;
  private pubUrl: string;
  private sonarUrl: string;

  private sub: ZMQSub;
  private rpc: ZMQRep;
  private pub: ZMQPub;
  private sonarSub: ZMQSub;
  private queue: AsyncQueue;
  private logger: ConsolaInstance;
  private shouldBeConnected = false;
  private shouldBeSonarConnected = false;
  private autoConnectSonar: boolean;
  private socketReady: Record<SocketName, boolean> = {
    sub: false,
    rpc: false,
    pub: false,
  };
  private sonarReady = false;

  constructor({
    subUrl = DEFAULT_SUB_URL,
    rpcUrl = DEFAULT_RPC_URL,
    pubUrl = DEFAULT_PUB_URL,
    sonarUrl = DEFAULT_SONAR_URL,
    timeout = 2000,
    reconnectInterval = 2000,
    logLevel = LogLevels.info,
    autoConnect = false,
    autoConnectSonar = false,
  }: Options = {}) {
    super();

    this.timeout = timeout;
    this.reconnectInterval = reconnectInterval;

    this.subUrl = subUrl;
    this.rpcUrl = rpcUrl;
    this.pubUrl = pubUrl;
    this.sonarUrl = sonarUrl;
    this.autoConnectSonar = autoConnectSonar;

    this.sub = new ZMQSub();
    this.rpc = new ZMQRep();
    this.pub = new ZMQPub();
    this.sonarSub = new ZMQSub();

    this.queue = new AsyncQueue();
    this.logger = createConsola({
      level: logLevel,
      formatOptions: { colors: true, compact: false },
    });

    this.bindSocketLifecycle("sub", this.sub);
    this.bindSocketLifecycle("rpc", this.rpc);
    this.bindSocketLifecycle("pub", this.pub);
    this.bindSonarLifecycle(this.sonarSub);

    this.sub.on("message", (topic, msg) => {
      this.handleTelemetryMessage("sub", topic, msg);
    });

    this.sonarSub.on("message", (topic, msg) => {
      this.handleTelemetryMessage("sonar-sub", topic, msg);
    });

    if (autoConnect) {
      this.connect();
    }
  }

  private updateState(newState: State) {
    if (this.state === newState) {
      return;
    }

    this.state = newState;
    this.logger.info(`[client] ${newState}`);
    this.emit(newState);
  }

  private updateSonarState(newState: State) {
    if (this.sonarState === newState) {
      return;
    }

    this.sonarState = newState;
    this.logger.info(`[sonar-client] ${newState}`);
    this.emit(SONAR_STATE_EVENTS[newState]);
  }

  private handleTelemetryMessage(
    socketName: "sub" | "sonar-sub",
    topic: Buffer,
    msg: Uint8Array,
  ) {
    const { key, data } = responseSchema.parse({ key: topic, data: msg });

    if (!isInProtocol(key) || !key.endsWith("Tel")) {
      this.logger.warn(`[${socketName}] unknown protocol:`, key);
      return;
    }

    const protocol = blueye.protocol[key as Tel];
    const message = protocol.decode(data) as DecodedTelOutput<Tel>;

    this.logger.verbose(`[${socketName}] message:`, key, message);
    this.emit(key as Tel, message as never);
  }

  private bindSocketLifecycle(
    name: SocketName,
    socket: ConnectionLifecycleSocket,
  ) {
    socket.on("ready", () => {
      this.setSocketReady(name, true);
    });

    socket.on("lost", () => {
      this.setSocketReady(name, false);
    });
  }

  private bindSonarLifecycle(socket: ConnectionLifecycleSocket) {
    socket.on("ready", () => {
      this.setSonarReady(true);
    });

    socket.on("lost", () => {
      this.setSonarReady(false);
    });
  }

  private setSocketReady(name: SocketName, ready: boolean) {
    if (this.socketReady[name] === ready) {
      return;
    }

    this.socketReady[name] = ready;
    this.logger.debug(`[client] ${name} socket ${ready ? "ready" : "lost"}`);

    if (!this.shouldBeConnected) {
      return;
    }

    if (this.allSocketsReady()) {
      this.updateState("connected");
      return;
    }

    this.updateState("connecting");
  }

  private resetSocketReadiness() {
    this.socketReady.sub = false;
    this.socketReady.rpc = false;
    this.socketReady.pub = false;
  }

  private allSocketsReady() {
    return this.socketReady.sub && this.socketReady.rpc && this.socketReady.pub;
  }

  private setSonarReady(ready: boolean) {
    if (this.sonarReady === ready) {
      return;
    }

    this.sonarReady = ready;
    this.logger.debug(`[sonar-client] socket ${ready ? "ready" : "lost"}`);

    if (!this.shouldBeSonarConnected) {
      return;
    }

    if (this.sonarReady) {
      this.updateSonarState("connected");
      return;
    }

    this.updateSonarState("connecting");
  }

  connectSonar() {
    if (this.sonarState === "connected") {
      return;
    }

    if (this.sonarState === "connecting") {
      return;
    }

    this.shouldBeSonarConnected = true;
    this.sonarReady = false;
    this.sonarSub.options.reconnectInterval = this.reconnectInterval;
    this.updateSonarState("connecting");
    this.sonarSub.subscribe("");
    this.sonarSub.connect(this.sonarUrl);
  }

  disconnectSonar() {
    this.shouldBeSonarConnected = false;
    this.sonarReady = false;

    if (this.sonarState === "disconnected") {
      return;
    }

    this.sonarSub.unsubscribe("");
    this.sonarSub.disconnect(this.sonarUrl);
    this.updateSonarState("disconnected");
  }

  private ensureConnected(operation: "request" | "control") {
    if (this.state !== "connected") {
      throw new Error(
        `[client] cannot send ${operation} while ${this.state}; call connect() and wait for "connected"`,
      );
    }
  }

  connect() {
    if (this.state === "connected") {
      this.logger.warn("[client] already connected");
      return;
    }

    if (this.state === "connecting") {
      this.logger.warn(`[client] already ${this.state}`);
      return;
    }

    this.sub.options.reconnectInterval = this.reconnectInterval;
    this.rpc.options.reconnectInterval = this.reconnectInterval;
    this.pub.options.reconnectInterval = this.reconnectInterval;

    this.shouldBeConnected = true;
    this.resetSocketReadiness();
    this.updateState("connecting");
    this.sub.subscribe("");
    this.sub.connect(this.subUrl);
    this.rpc.connect(this.rpcUrl);
    this.pub.connect(this.pubUrl);

    if (this.autoConnectSonar) {
      this.connectSonar();
    }
  }

  disconnect() {
    if (this.state === "disconnected") {
      this.logger.warn("[client] already disconnected");
      return;
    }

    this.shouldBeConnected = false;
    this.disconnectSonar();
    this.sub.unsubscribe("");
    this.sub.disconnect(this.subUrl);
    this.rpc.disconnect(this.rpcUrl);
    this.pub.disconnect(this.pubUrl);
    this.resetSocketReadiness();
    this.updateState("disconnected");
  }

  async sendRequest<T extends Req>(
    req: T,
    opts: CreateArgs<T> = {},
  ): Promise<DecodedOutput<T> | null> {
    this.ensureConnected("request");

    if (!isInProtocol(req) || !req.endsWith("Req")) {
      throw new Error(`[rpc] unknown protocol: ${req}`);
    }

    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as any).finish();

    const request = () => {
      return new Promise<z.infer<typeof responseSchema>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("[rpc] request timed out")),
          this.timeout,
        );

        this.rpc.once("message", (topic, msg) => {
          clearTimeout(timer);
          resolve({ key: topic.toString().split(".").at(-1), data: msg });
        });

        this.rpc.send([
          Buffer.from(`blueye.protocol.${req}`),
          Buffer.from(encoded),
        ]);
      });
    };

    const { key, data } = await this.queue.enqueue(request);

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
    this.ensureConnected("control");

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
