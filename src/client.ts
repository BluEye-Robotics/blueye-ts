import {
  type ConsolaInstance,
  createConsola,
  type LogLevel,
  LogLevels,
} from "consola";
import { Emitter } from "strict-event-emitter";
import {
  type ConnectionState,
  ConnectionTracker,
  type ConnectionTransition,
  type SocketName,
} from "./connection-state";
import {
  type CreateArgs,
  type Ctrl,
  type DecodedOutput,
  type DecodedTelOutput,
  decodeMessage,
  encodeMessage,
  isCtrl,
  isRep,
  isReq,
  isTel,
  keyToTopic,
  type Req,
  type Tel,
  topicToKey,
} from "./protocol";
import { RequestPipeline } from "./request-pipeline";
import { detectSonar } from "./sonar-device";
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

export type Events = {
  [K in ConnectionState]: [];
} & {
  [K in `${SocketName}-${ConnectionState}`]: [];
} & {
  [K in Tel]: [DecodedTelOutput<K>];
};

type Options = Partial<{
  subUrl: string;
  rpcUrl: string;
  pubUrl: string;
  sonarUrl: string;
  timeout: number;
  reconnectInterval: number;
  stalenessTimeout: number;
  logLevel: LogLevel;
  autoConnect: boolean;
  transport: Transport;
}>;

export class BlueyeClient extends Emitter<Events> {
  public timeout: number;
  public reconnectInterval: number;
  public stalenessTimeout: number;

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
  private lastSubMessageAt: number | null = null;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor({
    subUrl = DEFAULT_SUB_URL,
    rpcUrl = DEFAULT_RPC_URL,
    pubUrl = DEFAULT_PUB_URL,
    sonarUrl = DEFAULT_SONAR_URL,
    timeout = 2000,
    reconnectInterval = 2000,
    stalenessTimeout = 5000,
    logLevel = LogLevels.info,
    autoConnect = false,
    transport = new JszmqTransport(),
  }: Options = {}) {
    super();

    this.timeout = timeout;
    this.reconnectInterval = reconnectInterval;
    this.stalenessTimeout = stalenessTimeout;

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
      this.lastSubMessageAt = Date.now();
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
    const key = topicToKey(topic);

    if (!isTel(key)) {
      this.logger.warn(`[${socketName}] unknown protocol:`, key);
      return;
    }

    const message = decodeMessage(key, msg);

    this.logger.verbose(`[${socketName}] message:`, key, message);
    this.emit(key, message as never);
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

  private startStalenessWatchdog() {
    this.stopStalenessWatchdog();
    if (this.stalenessTimeout <= 0) return;

    const checkInterval = Math.max(100, Math.floor(this.stalenessTimeout / 4));
    this.stalenessTimer = setInterval(() => {
      this.checkTelemetryStaleness();
    }, checkInterval);
  }

  private stopStalenessWatchdog() {
    if (this.stalenessTimer != null) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
  }

  private checkTelemetryStaleness() {
    // Only armed while connected AND after telemetry has actually flowed —
    // a connection that never produced telemetry is not judged stale.
    if (this.state !== "connected" || this.lastSubMessageAt == null) return;

    const silentFor = Date.now() - this.lastSubMessageAt;
    if (silentFor <= this.stalenessTimeout) return;

    this.logger.warn(
      `[watchdog] no telemetry for ${silentFor}ms; dropping connections to force a reconnect`,
    );
    // Re-arm only once telemetry flows again, so a live-but-quiet server
    // doesn't get dropped in a loop.
    this.lastSubMessageAt = null;

    // Convert the silent failure into the explicit loss the state machine
    // already handles: sockets emit "lost" and their reconnect loop runs.
    this.sub.dropConnection();
    this.rpc.dropConnection();
    this.pub.dropConnection();
    this.sonarSub.dropConnection();
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

    const detection = detectSonar(msg);

    if (!detection.detected) {
      if (
        detection.reason === "incompatible-firmware" &&
        !this.sonarIncompatibilityWarned
      ) {
        this.sonarIncompatibilityWarned = true;
        this.logger.warn(
          `[sonar] incompatible Blunux version detected in DroneInfoTel: ${detection.version}; sonar telemetry may not be available`,
        );
      }
      return;
    }

    this.logger.info(
      `[sonar] multibeam device detected in DroneInfoTel (deviceId: ${detection.deviceId})`,
    );
    const transitions = this.tracker.sonarDetected();
    this.sonarSub.connect(this.sonarUrl);
    this.applyTransitions(transitions);
  }

  connect() {
    if (this.tracker.intended) {
      this.logger.warn("[client] already connecting or connected");
      return;
    }

    this.sonarIncompatibilityWarned = false;
    this.lastSubMessageAt = null;
    this.startStalenessWatchdog();
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

    this.stopStalenessWatchdog();
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

    this.stopStalenessWatchdog();
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

    if (!isReq(req)) {
      throw new Error(`[rpc] unknown protocol: ${req}`);
    }

    const encoded = encodeMessage(req, opts);

    const [topic, data] = await this.pipeline.request(
      [keyToTopic(req), encoded],
      this.timeout,
    );
    const key = topicToKey(topic);

    if (key === "Empty") {
      return null;
    }

    if (!isRep(key)) {
      throw new Error(`[rpc] unknown response protocol: ${key}`);
    }

    const result = decodeMessage(key, data) as DecodedOutput<T>;

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

    if (!response.payload) {
      throw new Error(`[rpc] no cached telemetry available for: ${type}`);
    }

    const key = topicToKey(response.payload.typeUrl);

    if (!isTel(key)) {
      throw new Error(`[rpc] unknown telemetry typeUrl: ${key}`);
    }

    const result = decodeMessage(
      key,
      response.payload.value,
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

    if (!isCtrl(ctrl)) {
      throw new Error(`[pub] unknown protocol: ${ctrl}`);
    }

    const encoded = encodeMessage(ctrl, opts);

    this.logger.debug("[pub] sending control:", ctrl, opts);
    this.pub.send([keyToTopic(ctrl), encoded]);
  }
}
