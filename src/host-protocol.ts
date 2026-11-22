import { createHash } from "node:crypto";
import { z } from "zod";

export const HOST_API_VERSION = 1;
export const HOST_MESSAGE_PAGE_SIZE = 100;

export const HostCreateSchema = z.strictObject({
  createKey: z.string().trim().min(1).max(256),
  parentTaskId: z.string().trim().min(1).max(256),
  agent: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(256),
  cwd: z.string().max(4096).optional(),
  model: z.string().max(1024).optional(),
  thinking: z.string().max(1024).optional(),
});

export const HostDispatchSchema = z.strictObject({
  to: z.string().trim().min(1).max(256),
  messageId: z.string().trim().min(1).max(256),
  kind: z.literal("dispatch"),
  body: z
    .string()
    .min(1)
    .max(64 * 1024),
});

export type HostMessageKind =
  "collaboration" | "done" | "blocked" | "runtime_notice";

export interface HostEnvelope {
  id: string;
  owner_task_id: string;
  parent_task_id: string;
  kind: HostMessageKind;
  body: string;
  runtime_kind: string | null;
  reason: string | null;
  queued_at: number;
}

const HostEnvelopeSchema = z.strictObject({
  id: z.string().min(1),
  owner_task_id: z.string().min(1),
  parent_task_id: z.string().min(1),
  kind: z.enum(["collaboration", "done", "blocked", "runtime_notice"]),
  body: z.string(),
  runtime_kind: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  queued_at: z.number(),
});

export function parseHostEnvelope(value: unknown): HostEnvelope {
  const record = HostEnvelopeSchema.parse(value);
  return {
    ...record,
    runtime_kind: record.runtime_kind ?? null,
    reason: record.reason ?? null,
  };
}

export interface HostDescription {
  host_api_version: number;
  agent_ids: string[];
}

export function parseHostDescription(value: unknown): HostDescription {
  return z
    .strictObject({
      host_api_version: z.number(),
      agent_ids: z.array(z.string()),
    })
    .parse(value);
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function targetNotFoundBody(): {
  error: string;
  code: "target_not_found";
} {
  return { error: "Host task not found", code: "target_not_found" };
}
