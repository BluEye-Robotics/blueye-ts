export type SocketName = "sub" | "rpc" | "pub" | "sonar";
export type ConnectionState = "connecting" | "connected" | "disconnected";

export type ConnectionTransition =
  | { scope: "socket"; name: SocketName; state: ConnectionState }
  | { scope: "client"; state: ConnectionState };

const CORE_SOCKETS = ["sub", "rpc", "pub"] as const;

/**
 * Owns every piece of connection state: the connect/disconnect intent, the
 * per-socket readiness, and whether a detected sonar makes the sonar socket
 * required. All mutations go through the methods below, and each returns the
 * exact list of transitions that occurred — a transition is only ever
 * reported when something actually changed, so consumers can treat the
 * resulting events as edge-triggered.
 */
export class ConnectionTracker {
  private intent = false;
  private sonarRequired = false;
  private pending: ConnectionTransition[] = [];
  private sockets: Record<SocketName, ConnectionState> = {
    sub: "disconnected",
    rpc: "disconnected",
    pub: "disconnected",
    sonar: "disconnected",
  };

  /** True between connectRequested() and disconnectRequested(). */
  get intended(): boolean {
    return this.intent;
  }

  /** True once a sonar has been detected on the current connection. */
  get isSonarRequired(): boolean {
    return this.sonarRequired;
  }

  get state(): ConnectionState {
    if (!this.intent) return "disconnected";

    const required: readonly SocketName[] = this.sonarRequired
      ? [...CORE_SOCKETS, "sonar"]
      : CORE_SOCKETS;

    return required.every((name) => this.sockets[name] === "connected")
      ? "connected"
      : "connecting";
  }

  connectRequested(): ConnectionTransition[] {
    if (this.intent) return [];
    return this.collect(() => {
      this.intent = true;
      for (const name of CORE_SOCKETS) {
        this.setSocket(name, "connecting");
      }
    });
  }

  disconnectRequested(): ConnectionTransition[] {
    if (!this.intent) return [];
    return this.collect(() => {
      this.intent = false;
      // Sonar detection is per-connection: the next connect() starts without
      // requiring the sonar socket until a sonar is detected again.
      this.sonarRequired = false;
      for (const name of Object.keys(this.sockets) as SocketName[]) {
        this.setSocket(name, "disconnected");
      }
    });
  }

  socketReady(name: SocketName): ConnectionTransition[] {
    if (!this.intent) return [];
    return this.collect(() => {
      this.setSocket(name, "connected");
    });
  }

  socketLost(name: SocketName): ConnectionTransition[] {
    if (!this.intent) return [];
    return this.collect(() => {
      this.setSocket(name, "connecting");
    });
  }

  sonarDetected(): ConnectionTransition[] {
    if (!this.intent || this.sonarRequired) return [];
    return this.collect(() => {
      this.sonarRequired = true;
      this.setSocket("sonar", "connecting");
    });
  }

  private setSocket(name: SocketName, state: ConnectionState) {
    if (this.sockets[name] === state) return;
    this.sockets[name] = state;
    this.pending.push({ scope: "socket", name, state });
  }

  private collect(mutate: () => void): ConnectionTransition[] {
    const before = this.state;
    this.pending = [];
    mutate();
    const transitions = this.pending;
    this.pending = [];
    if (this.state !== before) {
      transitions.push({ scope: "client", state: this.state });
    }
    return transitions;
  }
}
