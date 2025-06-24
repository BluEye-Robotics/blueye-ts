import { Buffer } from "buffer";
import z from "zod";

export const responseSchema = z.object({
  id: z.string().uuid().optional(),
  key: z.string().transform(val => val.split(".").at(-1)!),
  data: z
    .string()
    .base64()
    .transform(val => Buffer.from(val, "base64"))
});

export const telemetrySchema = z.object({
  payload: z.object({
    typeUrl: z.string().transform(val => val.split(".").at(-1)!),
    value: z
      .any()
      .refine(val => val instanceof Buffer || val instanceof Uint8Array)
      .transform(val => (Buffer.isBuffer(val) ? val : Buffer.from(val)))
  })
});
