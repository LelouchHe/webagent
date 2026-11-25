import { z } from "zod";

const messageDataSchema = z.object({
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  sourceLabel: z.string(),
  body: z.string(),
});

const receiptDataSchema = z.discriminatedUnion("status", [
  z.object({
    originalEntryId: z.uuid(),
    status: z.literal("delivered"),
  }),
  z.object({
    originalEntryId: z.uuid(),
    status: z.literal("failed"),
    failureReason: z.string(),
  }),
]);

export const linkEnvelopeSchema = z.discriminatedUnion("category", [
  z.object({
    id: z.uuid(),
    category: z.literal("message"),
    data: messageDataSchema,
  }),
  z.object({
    id: z.uuid(),
    category: z.literal("report"),
    data: messageDataSchema,
  }),
  z.object({
    id: z.uuid(),
    category: z.literal("receipt"),
    data: receiptDataSchema,
  }),
]);

export type LinkEnvelope = z.infer<typeof linkEnvelopeSchema>;
export type LinkMessageData = z.infer<typeof messageDataSchema>;
export type LinkReceiptData = z.infer<typeof receiptDataSchema>;

export class LinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkProtocolError";
  }
}

export function parseLinkEnvelope(input: unknown): LinkEnvelope {
  const result = linkEnvelopeSchema.safeParse(input);
  if (!result.success) throw new LinkProtocolError("invalid_link_envelope");
  return result.data;
}
