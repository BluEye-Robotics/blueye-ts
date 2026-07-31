import type {
  SocketKind,
  Transport,
  TransportEvents,
  TransportFrame,
  TransportSocket,
} from "./transport";

const utf8Encoder = new TextEncoder();

const encodeFrame = (frame: TransportFrame): Uint8Array =>
  typeof frame === "string" ? utf8Encoder.encode(frame) : frame;

type Listener = (...args: never[]) => void;
type OnceWrapper = Listener & { original?: Listener };

class MiniEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  once(event: string, listener: Listener) {
    const wrapper: OnceWrapper = (...args: never[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    // Track the original so off(listener) also removes the wrapper
    wrapper.original = listener;
    this.on(event, wrapper);
  }

  off(event: string, listener: Listener) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const registered of set) {
      if (
        registered === listener ||
        (registered as { original?: Listener }).original === listener
      ) {
        set.delete(registered);
      }
    }
  }

  emit(event: string, ...args: unknown[]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

export type InMemoryReply = (frames: TransportFrame[]) => void;
export type InMemoryMessageHandler = (
  frames: Uint8Array[],
  reply: InMemoryReply,
) => void;

/**
 * The "server" end of an in-memory URL. Tests use it to receive what the
 * client sends and to publish or reply with frames of their own.
 */
export class InMemoryEndpoint {
  private handlers: InMemoryMessageHandler[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private hub: InMemoryTransport,
  ) {}

  onMessage(handler: InMemoryMessageHandler) {
    this.handlers.push(handler);
  }

  /** Broadcast frames to every subscribed socket connected to this URL. */
  send(frames: TransportFrame[]) {
    this.hub.broadcast(this.url, frames.map(encodeFrame));
  }

  /** Simulate server loss: connected sockets emit "lost" and re-attach when a new endpoint is listening. */
  close() {
    this.closed = true;
    this.hub.dropEndpoint(this.url);
  }

  deliver(frames: Uint8Array[], reply: InMemoryReply) {
    for (const handler of this.handlers) {
      handler(frames, reply);
    }
  }
}

class InMemorySocket implements TransportSocket {
  private emitter = new MiniEmitter();
  private wantedUrls = new Set<string>();
  private attachedUrls = new Set<string>();
  private subscriptions = new Set<string>();
  private closed = false;

  constructor(
    readonly kind: SocketKind,
    private hub: InMemoryTransport,
  ) {}

  connect(url: string) {
    if (this.closed) return;
    this.wantedUrls.add(url);
    this.hub.tryAttach(this, url);
  }

  disconnect(url: string) {
    this.wantedUrls.delete(url);
    this.attachedUrls.delete(url);
  }

  close() {
    this.closed = true;
    this.wantedUrls.clear();
    this.attachedUrls.clear();
    this.hub.removeSocket(this);
  }

  send(frames: TransportFrame[]) {
    if (this.closed) return;
    const encoded = frames.map(encodeFrame);
    for (const url of this.attachedUrls) {
      const endpoint = this.hub.endpoint(url);
      endpoint?.deliver(encoded, (reply) => {
        this.emitMessage(reply.map(encodeFrame));
      });
    }
  }

  subscribe(topic: string) {
    this.subscriptions.add(topic);
  }

  unsubscribe(topic: string) {
    this.subscriptions.delete(topic);
  }

  setReconnectInterval(_ms: number) {
    // Reconnection is event-driven in-memory: sockets re-attach as soon as an
    // endpoint starts listening again, so the interval is irrelevant.
  }

  on<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.emitter.on(event, listener as Listener);
  }

  once<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.emitter.once(event, listener as Listener);
  }

  off<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.emitter.off(event, listener as Listener);
  }

  wants(url: string) {
    return !this.closed && this.wantedUrls.has(url);
  }

  isAttached(url: string) {
    return this.attachedUrls.has(url);
  }

  attach(url: string) {
    if (this.closed || !this.wantedUrls.has(url)) return;
    if (this.attachedUrls.has(url)) return;
    this.attachedUrls.add(url);
    queueMicrotask(() => {
      if (this.attachedUrls.has(url)) {
        this.emitter.emit("ready");
      }
    });
  }

  detach(url: string) {
    if (!this.attachedUrls.delete(url)) return;
    queueMicrotask(() => {
      if (!this.closed) {
        this.emitter.emit("lost");
      }
    });
  }

  emitMessage(frames: Uint8Array[]) {
    if (this.closed) return;
    const [topic, payload] = frames;
    queueMicrotask(() => {
      if (!this.closed) {
        this.emitter.emit("message", topic, payload);
      }
    });
  }
}

/**
 * In-memory adapter for the transport seam. Deterministic and portless:
 * sockets attach to endpoints the moment both sides exist, loss and recovery
 * are explicit method calls, and no timers are involved.
 */
export class InMemoryTransport implements Transport {
  private endpoints = new Map<string, InMemoryEndpoint>();
  private sockets = new Set<InMemorySocket>();

  createSocket(kind: SocketKind): TransportSocket {
    const socket = new InMemorySocket(kind, this);
    this.sockets.add(socket);
    return socket;
  }

  /** Bring up the server end of a URL. Sockets wanting it attach immediately. */
  listen(url: string): InMemoryEndpoint {
    const endpoint = new InMemoryEndpoint(url, this);
    this.endpoints.set(url, endpoint);
    for (const socket of this.sockets) {
      this.tryAttach(socket, url);
    }
    return endpoint;
  }

  endpoint(url: string): InMemoryEndpoint | undefined {
    return this.endpoints.get(url);
  }

  /** Close every endpoint — simulates losing the whole server. */
  closeAll() {
    for (const endpoint of [...this.endpoints.values()]) {
      endpoint.close();
    }
  }

  tryAttach(socket: InMemorySocket, url: string) {
    if (this.endpoints.has(url) && socket.wants(url)) {
      socket.attach(url);
    }
  }

  dropEndpoint(url: string) {
    this.endpoints.delete(url);
    for (const socket of this.sockets) {
      socket.detach(url);
    }
  }

  removeSocket(socket: InMemorySocket) {
    this.sockets.delete(socket);
  }

  broadcast(url: string, frames: Uint8Array[]) {
    for (const socket of this.sockets) {
      if (socket.kind === "sub" && socket.isAttached(url)) {
        socket.emitMessage(frames);
      }
    }
  }
}
