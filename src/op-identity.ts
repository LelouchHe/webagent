// Deterministic ids for idempotent operations: the id of the fact an
// operation creates is derived from who asked and the op id they sent, so a
// replay finds the same row instead of creating a second one.

import { createHash } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed UUID namespace for REST collaboration message op identity. */
export const COLLABORATION_MESSAGE_NAMESPACE =
  "9a4c5e8f-2b71-4d3a-9c6e-1f08b4a27d53";

/** Fixed UUID namespace for deterministic task creation op identity. */
export const TASK_CREATE_NAMESPACE = "3d7e4b1a-8f25-4c6e-a109-6b5d82e3f417";

/** RFC 4122 UUIDv5 of `${caller}\0${opId}` in the `namespace` UUID. */
export function opIdentity(
  namespace: string,
  caller: string,
  opId: string,
): string {
  if (!UUID_PATTERN.test(namespace)) throw new Error("invalid_uuid_namespace");
  const digest = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(`${caller}\0${opId}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
