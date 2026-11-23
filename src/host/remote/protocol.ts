import { z } from "zod";

export const HOST_PROTOCOL_VERSION = 1;

const HostDescriptionSchema = z.strictObject({
  protocol: z.literal(HOST_PROTOCOL_VERSION),
  server: z.string().min(1),
  caller: z.strictObject({
    name: z.string().min(1),
    scope: z.enum(["api", "admin"]),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "fingerprint must be a sha256 hex digest"),
  }),
});

export type HostDescription = z.infer<typeof HostDescriptionSchema>;

export function parseHostDescription(value: unknown): HostDescription {
  return HostDescriptionSchema.parse(value);
}
