export const MAX_COLLABORATION_SOURCE_LABEL_LENGTH = 200;

export function assertCollaborationSourceLabel(
  value: string,
): asserts value is string {
  if (
    value.length === 0 ||
    value.length > MAX_COLLABORATION_SOURCE_LABEL_LENGTH ||
    /[\r\n\u2028\u2029]/.test(value)
  ) {
    throw new Error("invalid_source_label");
  }
}

export interface HostCollaborationCommand {
  receive(input: {
    sourceTaskId: string;
    targetTaskId: string;
    peerTokenHash: string;
    body: string;
    sourceLabel?: string;
  }): {
    messageId: string;
    deliveryId: string;
  };
}

export class HostExternalParentError extends Error {
  constructor() {
    super("host_not_external_parent");
  }
}
