import type { CollaborationMessageRow, TaskRow } from "./store.ts";

export type CollaborationRelation = "self" | "parent" | "child";

export function collaborationRelation(
  source: Pick<TaskRow, "id" | "parent_id">,
  target: Pick<TaskRow, "id" | "parent_id">,
): CollaborationRelation | null {
  if (source.id === target.id) return "self";
  if (source.parent_id === target.id) return "parent";
  if (target.parent_id === source.id) return "child";
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
 * The single arming policy for directed dispatch closure, derived from data
 * the rows already carry — no classification field and no body inspection.
 *
 * Only an agent-authored direct parent→child dispatch asks for an account. A
 * user send (even from the parent session), a child message, a typed update,
 * and a runtime notice all fail one of the two conditions.
 */
export function shouldArm(
  message: Pick<CollaborationMessageRow, "source_actor" | "source_task_id">,
  target: Pick<TaskRow, "parent_id">,
  externalParentTaskId?: string,
): boolean {
  return (
    message.source_actor === "agent" &&
    (target.parent_id === message.source_task_id ||
      externalParentTaskId === message.source_task_id)
  );
}
