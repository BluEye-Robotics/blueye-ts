// The jszmq transport's opening handshakes, against a browser WebSocket that
// never opens: the Safari LAN stall that jszmq's openAttemptInterval recovers
// by starting a second, overlapping attempt to the same address.
import { LogLevels } from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlueyeClient } from "../src/client.js";

const interval = 10_000;
const urls = {
  subUrl: "ws://192.168.1.101:9985",
  rpcUrl: "ws://192.168.1.101:9986",
  pubUrl: "ws://192.168.1.101:9987",
  sonarUrl: "ws://192.168.1.101:9988",
  slamUrl: "ws://192.168.1.101:9989",
};
const attempts: string[] = [];

class StalledWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;

  constructor(url: string) {
    attempts.push(url);
  }

  send() {}

  close() {
    this.readyState = this.CLOSING;
  }
}

const attemptsTo = (url: string) => attempts.filter((u) => u === url).length;

const createClient = (options: Record<string, unknown> = {}) =>
  new BlueyeClient({ ...urls, logLevel: LogLevels.silent, ...options });

describe("openAttemptInterval", () => {
  let client: BlueyeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", StalledWebSocket);
    attempts.length = 0;
  });

  afterEach(() => {
    client.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("makes a single attempt per socket by default", () => {
    client = createClient();
    client.connect();
    vi.advanceTimersByTime(interval * 6);
    for (const url of [urls.subUrl, urls.rpcUrl, urls.pubUrl])
      expect(attemptsTo(url)).toBe(1);
  });

  it("starts a second attempt on each stalled socket after the interval", () => {
    client = createClient({ openAttemptInterval: interval });
    client.connect();
    vi.advanceTimersByTime(interval - 1);
    for (const url of [urls.subUrl, urls.rpcUrl, urls.pubUrl])
      expect(attemptsTo(url)).toBe(1);
    vi.advanceTimersByTime(1);
    for (const url of [urls.subUrl, urls.rpcUrl, urls.pubUrl])
      expect(attemptsTo(url)).toBe(2);
  });

  it("applies to the SLAM stream", () => {
    client = createClient({ openAttemptInterval: interval });
    client.connectSlam();
    vi.advanceTimersByTime(interval);
    expect(attemptsTo(urls.slamUrl)).toBe(2);
  });
});
