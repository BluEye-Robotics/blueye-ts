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
  constructor(private socket: JszmqSocketInstance) {}

  connect(url: string) {
    this.socket.connect(url);
  }

  disconnect(url: string) {
    this.socket.disconnect(url);
  }

  close() {
    this.socket.close();
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
