export interface HostCollaborationCommand {
  receive(input: {
    sourceTaskId: string;
    targetTaskId: string;
    peerTokenHash: string;
    body: string;
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
