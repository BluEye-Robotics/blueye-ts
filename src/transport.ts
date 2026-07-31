import {
  Pub as JszmqPub,
  Req as JszmqReq,
  Sub as JszmqSub,
} from "@blueyerobotics/jszmq";

export type SocketKind = "sub" | "req" | "pub";

export type TransportFrame = Uint8Array | string;

export type TransportEvents = {
  ready: [];
  lost: [];
  message: [topic: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>];
};

export type TransportSocket = {
  connect(url: string): void;
  disconnect(url: string): void;
  close(): void;
  /**
   * Force-drop the live connection(s) without forgetting the endpoints:
   * emits "lost" and lets the transport's normal reconnect machinery try to
   * re-establish. Used to convert silently-dead links into explicit loss.
   */
  dropConnection(): void;
  send(frames: TransportFrame[]): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  setReconnectInterval(ms: number): void;
  on<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ): void;
  once<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ): void;
  off<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ): void;
};

export type Transport = {
  createSocket(kind: SocketKind): TransportSocket;
};

type JszmqSocketInstance = JszmqSub | JszmqReq | JszmqPub;

class JszmqSocket implements TransportSocket {
  constructor(private socket: JszmqSocketInstance) {
    // A jszmq REQ socket is lockstep: once a request is sent it refuses to
    // send another until the reply arrives, and that flag survives connection
    // loss — wedging the socket forever if the server died mid-request.
    // Losing the connection means the reply can no longer arrive, so reset.
    if (socket instanceof JszmqReq) {
      socket.on("lost", () => {
        socket.receivingReply = false;
      });
    }
  }

  connect(url: string) {
    this.socket.connect(url);
  }

  disconnect(url: string) {
    this.socket.disconnect(url);
  }

  close() {
    this.socket.close();
  }

  dropConnection() {
    // Close each endpoint's raw WebSocket while leaving the endpoint
    // registered: jszmq treats an unexpected close as a loss — it emits
    // "lost" and schedules its own reconnect (webSocketEndpoint.onClose).
    // endpoint.close()/disconnect(url) would instead terminate the endpoint
    // permanently, which is exactly what we don't want here.
    const { endpoints } = this.socket as unknown as {
      endpoints?: { socket?: { close(): void } }[];
    };
    for (const endpoint of endpoints ?? []) {
      endpoint.socket?.close();
    }
  }

  send(frames: TransportFrame[]) {
    this.socket.send(frames);
  }

  subscribe(topic: string) {
    this.socket.subscribe(topic);
  }

  unsubscribe(topic: string) {
    this.socket.unsubscribe(topic);
  }

  setReconnectInterval(ms: number) {
    this.socket.options.reconnectInterval = ms;
  }

  on<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.socket.on(event, listener);
  }

  once<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.socket.once(event, listener);
  }

  off<E extends keyof TransportEvents>(
    event: E,
    listener: (...args: TransportEvents[E]) => void,
  ) {
    this.socket.removeListener(event, listener);
  }
}

export class JszmqTransport implements Transport {
  createSocket(kind: SocketKind): TransportSocket {
    switch (kind) {
      case "sub":
        return new JszmqSocket(new JszmqSub());
      case "req":
        return new JszmqSocket(new JszmqReq());
      case "pub":
        return new JszmqSocket(new JszmqPub());
    }
  }
}
