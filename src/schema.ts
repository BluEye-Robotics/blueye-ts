import z from "zod";

const utf8 = new TextDecoder();

export const responseSchema = z.object({
  key: z
    .instanceof(Uint8Array)
    .transform((val) => utf8.decode(val).split(".").at(-1) ?? ""),
  data: z.instanceof(Uint8Array),
});

export const telemetrySchema = z.object({
  payload: z.object({
    typeUrl: z.string().transform((val) => val.split(".").at(-1) ?? ""),
    value: z.instanceof(Uint8Array),
  }),
});
