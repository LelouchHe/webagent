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

export const peerEnvelopeSchema = z.discriminatedUnion("category", [
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

export type PeerEnvelope = z.infer<typeof peerEnvelopeSchema>;
export type PeerMessageData = z.infer<typeof messageDataSchema>;
export type PeerReceiptData = z.infer<typeof receiptDataSchema>;

export class PeerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerProtocolError";
  }
}

export function parsePeerEnvelope(input: unknown): PeerEnvelope {
  const result = peerEnvelopeSchema.safeParse(input);
  if (!result.success) throw new PeerProtocolError("invalid_peer_envelope");
  return result.data;
}
