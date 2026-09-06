import type { TaskRow } from "./store.ts";

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
