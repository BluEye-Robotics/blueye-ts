import type { TransportFrame, TransportSocket } from "./transport";

export type ReplyFrames = [topic: Uint8Array, payload: Uint8Array];

type Waiter = {
  resolve: (reply: ReplyFrames) => void;
  reject: (error: Error) => void;
};

/**
 * Owns the request/reply cycle over a REQ socket: requests are serialized
 * (one in flight at a time), each reply is correlated to the request that is
 * actually awaiting it, timeouts clean up after themselves, and one failed
 * request never affects the next.
 *
 * REQ sockets are lockstep — a new request cannot be sent while a reply is
 * still owed. After a timeout the pipeline keeps tracking the owed reply:
 * a late arrival is discarded (never mis-delivered to a later request), and
 * requests made while the reply is still owed fail fast. A connection loss
 * clears the slate.
 */
export class RequestPipeline {
  private tail: Promise<unknown> = Promise.resolve();
  private waiter: Waiter | null = null;
  private expectingReply = false;

  constructor(private socket: TransportSocket) {
    this.socket.on("message", (topic, payload) => {
      this.expectingReply = false;
      const waiter = this.waiter;
      this.waiter = null;
      // No waiter means the request timed out — the late reply is discarded
      waiter?.resolve([topic, payload]);
    });

    this.socket.on("lost", () => {
      this.expectingReply = false;
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.reject(new Error("[rpc] connection lost while awaiting reply"));
    });
  }

  request(frames: TransportFrame[], timeoutMs: number): Promise<ReplyFrames> {
    const result = this.tail.then(() => this.execute(frames, timeoutMs));
    // Isolation: one failed request must not poison the pipeline
    this.tail = result.catch(() => {});
    return result;
  }

  private execute(
    frames: TransportFrame[],
    timeoutMs: number,
  ): Promise<ReplyFrames> {
    return new Promise<ReplyFrames>((resolve, reject) => {
      if (this.expectingReply) {
        reject(
          new Error(
            "[rpc] previous request timed out and its reply is still owed; waiting for the reply or a reconnect",
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        // Keep expectingReply set: the reply is still owed, and the message
        // handler must discard it when (if) it arrives.
        this.waiter = null;
        reject(new Error("[rpc] request timed out"));
      }, timeoutMs);

      this.waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.expectingReply = true;

      try {
        this.socket.send(frames);
      } catch (error) {
        clearTimeout(timer);
        this.waiter = null;
        this.expectingReply = false;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
