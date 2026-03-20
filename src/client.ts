import { blueye } from "@blueyerobotics/protocol-definitions";
import { Buffer } from "buffer";
import {
  type ConsolaInstance,
  createConsola,
  type LogLevel,
  LogLevels,
} from "consola";
import {
  Pub as ZMQPub,
  Req as ZMQRep,
  Sub as ZMQSub,
} from "@blueyerobotics/jszmq";
import { Emitter } from "strict-event-emitter";
import type z from "zod";
import { AsyncQueue } from "./async-queue";
import { responseSchema, telemetrySchema } from "./schema";
import * as semver from "semver";

const DEFAULT_SUB_URL = "ws://192.168.1.101:9985";
const DEFAULT_RPC_URL = "ws://192.168.1.101:9986";
const DEFAULT_PUB_URL = "ws://192.168.1.101:9987";
const DEFAULT_SONAR_URL = "ws://192.168.1.101:9988";

export const MULTIBEAM_DEVICE_IDS = [13, 16, 18, 20, 29, 30, 41, 42];

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
export type SocketName = "sub" | "rpc" | "pub" | "sonar";
type ConnectionLifecycleSocket = {
  on(event: "ready" | "lost", listener: () => void): unknown;
};

export type Events = {
  [K in State]: [];
} & {
  [K in `${SocketName}-${State}`]: [];
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
}>;

const hasSonarEndpoint = (version: string): boolean => {
  const coercedVersion = semver.coerce(version);
  return coercedVersion
    ? semver.satisfies(coercedVersion, ">=4.7.0") || version.endsWith("-dev")
    : false;
};

export class BlueyeClient extends Emitter<Events> {
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
  private isSonarDetected = false;
  private socketState: Record<SocketName, State> = {
    sub: "disconnected",
    rpc: "disconnected",
    pub: "disconnected",
    sonar: "disconnected",
  };

  constructor({
    subUrl = DEFAULT_SUB_URL,
    rpcUrl = DEFAULT_RPC_URL,
    pubUrl = DEFAULT_PUB_URL,
    sonarUrl = DEFAULT_SONAR_URL,
    timeout = 2000,
    reconnectInterval = 2000,
    logLevel = LogLevels.info,
    autoConnect = false,
  }: Options = {}) {
    super();

    this.timeout = timeout;
    this.reconnectInterval = reconnectInterval;

    this.subUrl = subUrl;
    this.rpcUrl = rpcUrl;
    this.pubUrl = pubUrl;
    this.sonarUrl = sonarUrl;

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
    this.bindSocketLifecycle("sonar", this.sonarSub);

    this.sub.on("message", (topic, msg) => {
      this.handleTelemetryMessage("sub", topic, msg);
    });

    this.sonarSub.on("message", (topic, msg) => {
      this.handleTelemetryMessage("sonar", topic, msg);
    });

    this.once("DroneInfoTel", (msg) => {
      const version = msg.droneInfo?.blunuxVersion;

      if (!hasSonarEndpoint(version ?? "")) {
        this.logger.warn(
          `[sonar] incompatible Blunux version detected in DroneInfoTel: ${version}; sonar telemetry may not be available`,
        );
        return;
      }

      const devices = [
        ...(msg.droneInfo?.gp?.gp1?.deviceList?.devices ?? []),
        ...(msg.droneInfo?.gp?.gp2?.deviceList?.devices ?? []),
        ...(msg.droneInfo?.gp?.gp3?.deviceList?.devices ?? []),
      ].map((device) => device.deviceId);

      if (devices.some((deviceId) => MULTIBEAM_DEVICE_IDS.includes(deviceId))) {
        this.logger.info(
          "[sonar] multibeam device detected in DroneInfoTel:",
          devices,
        );
        this.isSonarDetected = true;
        this.sonarSub.connect(this.sonarUrl);
      }
    });

    if (autoConnect) {
      this.connect();
    }
  }

  get state(): State {
    if (!this.shouldBeConnected) return "disconnected";
    const { sub, rpc, pub } = this.socketState;
    if (
      sub === "connected" &&
      rpc === "connected" &&
      pub === "connected" &&
      (this.isSonarDetected ? this.socketState.sonar === "connected" : true)
    ) {
      return "connected";
    }
    return "connecting";
  }

  private updateSocketState(name: SocketName, newState: State) {
    if (this.socketState[name] === newState) {
      return;
    }

    this.socketState[name] = newState;
    this.logger.info(`[${name}] ${newState}`);
    this.emit(`${name}-${newState}`);

    // If all sockets are connected, emit "connected"
    this.emit(this.state);
  }

  private handleTelemetryMessage(
    socketName: "sub" | "sonar",
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
      if (!this.shouldBeConnected) return;
      this.updateSocketState(name, "connected");
    });

    socket.on("lost", () => {
      if (!this.shouldBeConnected) return;
      this.updateSocketState(name, "connecting");
    });
  }

  private ensureConnected(operation: "request" | "control") {
    if (this.state !== "connected") {
      throw new Error(
        `[client] cannot send ${operation} while ${this.state}; call connect() and wait for "connected"`,
      );
    }
  }

  connect() {
    if (this.shouldBeConnected) {
      this.logger.warn("[client] already connecting or connected");
      return;
    }

    this.sub.options.reconnectInterval = this.reconnectInterval;
    this.rpc.options.reconnectInterval = this.reconnectInterval;
    this.pub.options.reconnectInterval = this.reconnectInterval;
    this.sonarSub.options.reconnectInterval = this.reconnectInterval;

    this.shouldBeConnected = true;

    for (const name of ["sub", "rpc", "pub", "sonar"] as const) {
      this.updateSocketState(name, "connecting");
    }

    this.sub.subscribe("");
    this.sub.connect(this.subUrl);
    this.rpc.connect(this.rpcUrl);
    this.pub.connect(this.pubUrl);
    this.sonarSub.subscribe("");
  }

  disconnect() {
    if (!this.shouldBeConnected) {
      this.logger.warn("[client] already disconnected");
      return;
    }

    this.shouldBeConnected = false;

    this.sub.unsubscribe("");
    this.sub.disconnect(this.subUrl);
    this.rpc.disconnect(this.rpcUrl);
    this.pub.disconnect(this.pubUrl);
    this.sonarSub.unsubscribe("");
    this.sonarSub.disconnect(this.sonarUrl);

    for (const name of ["sub", "rpc", "pub", "sonar"] as const) {
      this.updateSocketState(name, "disconnected");
    }
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

    if (!response) {
      throw new Error(`[rpc] no response for telemetry request: ${type}`);
    }

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
