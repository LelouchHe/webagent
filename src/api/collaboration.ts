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
