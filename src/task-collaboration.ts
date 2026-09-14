import type { CollaborationMessageRow, TaskRow } from "./store.ts";

export type CollaborationRelation = "self" | "parent" | "child" | "sibling";

export function collaborationRelation(
  source: Pick<TaskRow, "id" | "parent_id">,
  target: Pick<TaskRow, "id" | "parent_id">,
): CollaborationRelation | null {
  if (source.id === target.id) return "self";
  if (source.parent_id === target.id) return "parent";
  if (target.parent_id === source.id) return "child";
  if (source.parent_id !== null && source.parent_id === target.parent_id) {
    return "sibling";
  }
  return null;
}

export function isLocalCollaborationTarget(
  source: Pick<TaskRow, "id" | "parent_id">,
  target: Pick<TaskRow, "id" | "parent_id">,
): boolean {
  return (
    collaborationRelation(source, target) !== null && source.id !== target.id
  );
}

/**
 * The single arming policy for directed dispatch closure. It is deliberately
 * derived from data the rows already carry — no classification field and no
 * body inspection.
 *
 * Only an agent-authored direct parent→child dispatch asks for an account.
 * A user send (even from the parent session), a sibling or child message, a
 * correlated account, and a runtime notice all fail one of the two conditions.
 */
export function shouldArm(
  message: Pick<CollaborationMessageRow, "source_actor">,
  source: Pick<TaskRow, "id">,
  target: Pick<TaskRow, "parent_id">,
): boolean {
  return message.source_actor === "agent" && target.parent_id === source.id;
}
