export function assertCollaborationSourceLabel(value: string): void {
  if (!value || value.length > 200 || /[\r\n\u2028\u2029]/.test(value)) {
    throw new Error("invalid_source_label");
  }
}

export interface HostCollaborationCommand {
  receive(input: {
    sourceTaskId: string;
    targetTaskId: string;
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
