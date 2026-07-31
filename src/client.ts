import { blueye } from "@blueyerobotics/protocol-definitions";
import {
  type ConsolaInstance,
  createConsola,
  type LogLevel,
  LogLevels,
} from "consola";
import * as semver from "semver";
import { Emitter } from "strict-event-emitter";
import {
  type ConnectionState,
  ConnectionTracker,
  type ConnectionTransition,
  type SocketName,
} from "./connection-state";
import { RequestPipeline } from "./request-pipeline";
import { responseSchema, telemetrySchema } from "./schema";
import {
  JszmqTransport,
  type Transport,
  type TransportSocket,
} from "./transport";

export type { ConnectionState, SocketName } from "./connection-state";

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

export type Events = {
  [K in ConnectionState]: [];
} & {
  [K in `${SocketName}-${ConnectionState}`]: [];
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
  transport: Transport;
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

  private sub: TransportSocket;
  private rpc: TransportSocket;
  private pub: TransportSocket;
  private sonarSub: TransportSocket;
  private pipeline: RequestPipeline;
  private logger: ConsolaInstance;
  private tracker = new ConnectionTracker();
  private sonarIncompatibilityWarned = false;

  constructor({
    subUrl = DEFAULT_SUB_URL,
    rpcUrl = DEFAULT_RPC_URL,
    pubUrl = DEFAULT_PUB_URL,
    sonarUrl = DEFAULT_SONAR_URL,
    timeout = 2000,
    reconnectInterval = 2000,
    logLevel = LogLevels.info,
    autoConnect = false,
    transport = new JszmqTransport(),
  }: Options = {}) {
    super();

    this.timeout = timeout;
    this.reconnectInterval = reconnectInterval;

    this.subUrl = subUrl;
    this.rpcUrl = rpcUrl;
    this.pubUrl = pubUrl;
    this.sonarUrl = sonarUrl;

    this.sub = transport.createSocket("sub");
    this.rpc = transport.createSocket("req");
    this.pub = transport.createSocket("pub");
    this.sonarSub = transport.createSocket("sub");

    this.pipeline = new RequestPipeline(this.rpc);
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

    // Any DroneInfoTel — whether primed via RPC on connect or arriving over
    // SUB later — can reveal a multibeam sonar.
    this.on("DroneInfoTel", (msg) => {
      this.evaluateSonarDetection(msg);
    });

    this.logger.info(`[client] ${this.state}`);

    if (autoConnect) {
      this.connect();
    }
  }

  get state(): ConnectionState {
    return this.tracker.state;
  }

  private applyTransitions(transitions: ConnectionTransition[]) {
    for (const transition of transitions) {
      if (transition.scope === "socket") {
        this.logger.info(`[${transition.name}] ${transition.state}`);
        this.emit(`${transition.name}-${transition.state}`);
      } else {
        this.logger.info(`[client] ${transition.state}`);
        this.emit(transition.state);
      }
    }
  }

  private handleTelemetryMessage(
    socketName: "sub" | "sonar",
    topic: Uint8Array,
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

  private bindSocketLifecycle(name: SocketName, socket: TransportSocket) {
    socket.on("ready", () => {
      this.applyTransitions(this.tracker.socketReady(name));
    });

    socket.on("lost", () => {
      this.applyTransitions(this.tracker.socketLost(name));
    });
  }

  private ensureConnected(operation: "rpc" | "pub") {
    if (this.state !== "connected") {
      throw new Error(
        `[client] cannot send ${operation} while ${this.state}; call connect() and wait for "connected"`,
      );
    }
  }

  // Bound so disconnect() can remove it if the connection never came up
  private primeSonarDetection = async () => {
    try {
      const msg = await this.getTelemetry("DroneInfoTel");
      this.evaluateSonarDetection(msg);
    } catch (error) {
      this.logger.trace(
        "[sonar] failed to get DroneInfoTel via RPC; waiting for SUB telemetry:",
        error,
      );
    }
  };

  private evaluateSonarDetection(msg: DecodedTelOutput<"DroneInfoTel">) {
    if (!this.tracker.intended || this.tracker.isSonarRequired) return;

    const version = msg.droneInfo?.blunuxVersion;

    if (!hasSonarEndpoint(version ?? "")) {
      if (!this.sonarIncompatibilityWarned) {
        this.sonarIncompatibilityWarned = true;
        this.logger.warn(
          `[sonar] incompatible Blunux version detected in DroneInfoTel: ${version}; sonar telemetry may not be available`,
        );
      }
      return;
    }

    const devices = [
      ...(msg.droneInfo?.gp?.gp1?.deviceList?.devices ?? []),
      ...(msg.droneInfo?.gp?.gp2?.deviceList?.devices ?? []),
      ...(msg.droneInfo?.gp?.gp3?.deviceList?.devices ?? []),
    ].map((device) => device.deviceId);

    if (devices.some((deviceId) => MULTIBEAM_DEVICE_IDS.includes(deviceId))) {
      this.logger.info("[sonar] multibeam device detected in DroneInfoTel");
      const transitions = this.tracker.sonarDetected();
      this.sonarSub.connect(this.sonarUrl);
      this.applyTransitions(transitions);
    }
  }

  connect() {
    if (this.tracker.intended) {
      this.logger.warn("[client] already connecting or connected");
      return;
    }

    this.sonarIncompatibilityWarned = false;
    this.once("connected", this.primeSonarDetection);

    this.sub.setReconnectInterval(this.reconnectInterval);
    this.rpc.setReconnectInterval(this.reconnectInterval);
    this.pub.setReconnectInterval(this.reconnectInterval);
    this.sonarSub.setReconnectInterval(this.reconnectInterval);

    this.applyTransitions(this.tracker.connectRequested());

    this.sub.subscribe("");
    this.sub.connect(this.subUrl);
    this.rpc.connect(this.rpcUrl);
    this.pub.connect(this.pubUrl);
    this.sonarSub.subscribe("");
  }

  disconnect() {
    if (!this.tracker.intended) {
      this.logger.warn("[client] already disconnected");
      return;
    }

    this.off("connected", this.primeSonarDetection);

    this.sub.unsubscribe("");
    this.sub.disconnect(this.subUrl);
    this.rpc.disconnect(this.rpcUrl);
    this.pub.disconnect(this.pubUrl);
    this.sonarSub.unsubscribe("");
    this.sonarSub.disconnect(this.sonarUrl);

    this.applyTransitions(this.tracker.disconnectRequested());
  }

  /**
   * Permanently close all sockets and release their resources. The client
   * cannot be reused afterwards — create a new instance to reconnect.
   */
  close() {
    if (this.tracker.intended) {
      this.disconnect();
    }

    this.sub.close();
    this.rpc.close();
    this.pub.close();
    this.sonarSub.close();
  }

  async sendRequest<T extends Req>(
    req: T,
    opts: CreateArgs<T> = {},
  ): Promise<DecodedOutput<T> | null> {
    this.ensureConnected("rpc");

    if (!isInProtocol(req) || !req.endsWith("Req")) {
      throw new Error(`[rpc] unknown protocol: ${req}`);
    }

    const protocol = blueye.protocol[req];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as never).finish();

    const [topic, data] = await this.pipeline.request(
      [`blueye.protocol.${req}`, encoded],
      this.timeout,
    );
    const key = new TextDecoder().decode(topic).split(".").at(-1) ?? "";

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

  async waitForTelemetry<T extends Tel>(
    type: T,
    timeout: number | null = null,
  ): Promise<DecodedTelOutput<T>> {
    // Tries to get the latest telemetry via RPC first, in case we already have it cached in Blunux
    try {
      return await this.getTelemetry(type);
    } catch (error) {
      this.logger.trace(
        `[client] failed to get latest ${type} via RPC:`,
        error,
      );
    }

    // If that fails, wait for the next telemetry message to arrive via SUB
    return new Promise<DecodedTelOutput<T>>((resolve, reject) => {
      const listener = (...data: Events[T]) => {
        this.off(type, listener);
        if (timer) clearTimeout(timer);
        resolve(data[0] as DecodedTelOutput<T>);
      };

      const timer = timeout
        ? setTimeout(() => {
            this.off(type, listener);
            reject(
              new Error(`[client] timed out waiting for ${type} telemetry`),
            );
          }, timeout)
        : null;

      this.on(type, listener);
    });
  }

  async sendControl<T extends Ctrl>(ctrl: T, opts: CreateArgs<T> = {}) {
    this.ensureConnected("pub");

    if (!isInProtocol(ctrl) || !ctrl.endsWith("Ctrl")) {
      throw new Error(`[pub] unknown protocol: ${ctrl}`);
    }

    const protocol = blueye.protocol[ctrl];
    const message = protocol.create(opts);
    const encoded = protocol.encode(message as never).finish();

    this.logger.debug("[pub] sending control:", ctrl, message);
    this.pub.send([`blueye.protocol.${ctrl}`, encoded]);
  }
}
