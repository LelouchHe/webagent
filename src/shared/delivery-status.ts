export const COLLABORATION_DELIVERY_STATUSES = [
  "queued",
  "delivered",
  "failed",
] as const;

export type CollaborationDeliveryStatus =
  (typeof COLLABORATION_DELIVERY_STATUSES)[number];

export interface CollaborationDeliveryState {
  status: CollaborationDeliveryStatus;
  deliveredAt?: string;
  failureReason?: string;
}

export function isCollaborationDeliveryStatus(
  value: unknown,
): value is CollaborationDeliveryStatus {
  return (
    typeof value === "string" &&
    (COLLABORATION_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}
