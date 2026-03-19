# Copilot instructions for `blueye-ts`

## Build, lint, and validation commands

- Use `pnpm` for local work. The repo has a `pnpm-lock.yaml`, and CI installs with `pnpm install`.
- Build the package with `pnpm build` or `npm run build`. This runs `tsc` and emits CommonJS output plus declarations into `dist/`.
- Run the published example with `npm start` after building.
- There is no test framework or test script in this repository right now, so there is no full-test or single-test command to run.
- Biome is configured in `biome.json`, but there is no package script for it. Use the CLI directly, for example:
  - `pnpm exec biome check .`
  - `pnpm exec biome check src/client.ts` for a single file

## High-level architecture

- `index.ts` is the public surface. It re-exports the generated protocol definitions package along with the local `binlog-parser`, `client`, and `schema` modules.
- `src/client.ts` contains the main runtime API: `BlueyeClient`. It manages three ZMQ sockets with default Blueye endpoints:
  - `sub` for telemetry subscriptions on `ws://192.168.1.101:9985`
  - `rpc` for request/reply traffic on `ws://192.168.1.101:9986`
  - `pub` for control messages on `ws://192.168.1.101:9987`
- `BlueyeClient` is protocol-driven. It derives `Req`, `Rep`, `Tel`, and `Ctrl` types from `blueye.protocol` keys, then uses those suffix-based types to keep `sendRequest`, `getTelemetry`, and `sendControl` strongly typed.
- RPC requests in `src/client.ts` are serialized through `AsyncQueue` from `src/async-queue.ts`. Preserve that queueing behavior when changing request flow; it prevents overlapping request/response handling on the single RPC socket.
- Incoming socket payloads are validated at the boundary with Zod schemas from `src/schema.ts` before protocol decoding happens.
- `src/binlog-parser.ts` is the second major area of the library. It decompresses gzipped `.bez` binlogs, reads varint-length-prefixed `BinlogRecord` protobuf frames, decodes payloads through `blueye.protocol`, and normalizes message timestamps with `fixMessageTimes`.
- `parseFrame()` and `parseFrames()` are the streaming-oriented entry points for already decompressed frame bytes. `parse()` is the full-file convenience path for gzipped blobs.

## Key conventions in this repository

- Treat `@blueyerobotics/protocol-definitions` as the source of truth for message types. Local code should adapt to those generated definitions rather than re-declaring protocol payload shapes.
- Protocol routing is suffix-based. Code checks whether a key ends with `Req`, `Rep`, `Tel`, or `Ctrl`, and `isInProtocol()` guards that the key exists before decoding or sending.
- Outbound protobuf messages are created with `protocol.create(...)`, encoded with `protocol.encode(...).finish()`, and sent on multipart ZMQ messages where the topic is `blueye.protocol.<MessageName>`.
- Inbound telemetry and RPC responses are decoded only after Zod parsing extracts the protocol key and binary payload from the transport envelope.
- `GetTelemetryReq` is special: `getTelemetry()` requests it over RPC, validates the nested payload with `telemetrySchema`, then decodes the inner telemetry message using the protocol referenced by `payload.typeUrl`.
- `GetTelemetryRep` is also special in binlog parsing. `src/binlog-parser.ts` optionally decodes the nested telemetry payload into `innerData`.
- Logging uses `consola`, with socket-specific prefixes like `[sub]`, `[rpc]`, `[pub]`, and `[client]`. Follow that style when adding runtime logging.
- Formatting and linting follow Biome defaults configured here: spaces for indentation, double quotes for JavaScript/TypeScript, and import organization enabled.
- The package targets strict TypeScript and CommonJS output (`tsconfig.json`), so keep changes compatible with strict type checking and the existing published module format.
