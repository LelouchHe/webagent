import { z } from "zod/v4";
import type * as acp from "@agentclientprotocol/sdk";

// --- Config option (subset of ACP SessionConfigOption we care about) ---

export interface ConfigOption {
  type: "select";
  id: string;
  name: string;
  category?: string | null;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

// --- Agent events (server → client) ---

export type AgentEvent =
  | { type: "connected"; agent: { name: string; version: string }; configOptions: ConfigOption[] }
  | { type: "session_created"; sessionId: string; cwd?: string; title?: string | null; configOptions: ConfigOption[] }
  | { type: "config_option_update"; sessionId: string; configOptions: ConfigOption[] }
  | { type: "message_chunk"; sessionId: string; text: string }
  | { type: "thought_chunk"; sessionId: string; text: string }
  | { type: "tool_call"; sessionId: string; id: string; title: string; kind: string; rawInput?: unknown }
  | { type: "tool_call_update"; sessionId: string; id: string; status: string; content?: unknown[] }
  | { type: "plan"; sessionId: string; entries: unknown[] }
  | { type: "permission_request"; requestId: string; sessionId: string; title: string; toolCallId?: string | null; options: acp.PermissionOption[] }
  | { type: "prompt_done"; sessionId: string; stopReason: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_title_updated"; sessionId: string; title: string }
  | { type: "session_expired"; sessionId: string }
  | { type: "error"; message: string };

// --- Inbound WS messages (client → server) ---

const ImageSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
  path: z.string().optional(),
});

export const WsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_session"),
    cwd: z.string().optional(),
    inheritFromSessionId: z.string().optional(),
  }),
  z.object({ type: z.literal("resume_session"), sessionId: z.string() }),
  z.object({ type: z.literal("delete_session"), sessionId: z.string() }),
  z.object({
    type: z.literal("prompt"),
    sessionId: z.string(),
    text: z.string(),
    images: z.array(ImageSchema).optional(),
  }),
  z.object({
    type: z.literal("permission_response"),
    sessionId: z.string().optional(),
    requestId: z.string(),
    optionId: z.string().optional(),
    optionName: z.string().optional(),
    denied: z.boolean().optional(),
  }),
  z.object({ type: z.literal("cancel"), sessionId: z.string() }),
  z.object({ type: z.literal("set_config_option"), sessionId: z.string(), configId: z.string(), value: z.string() }),
  z.object({ type: z.literal("bash_exec"), sessionId: z.string(), command: z.string() }),
  z.object({ type: z.literal("bash_cancel"), sessionId: z.string() }),
]);

export type WsMessage = z.infer<typeof WsMessageSchema>;

// --- Utility ---

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
