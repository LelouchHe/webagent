import { scenario } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  waitForHost,
  type ProvisionedHostToken,
} from "../multi-host.ts";

export default scenario<ProvisionedHostToken>({
  mock: EMPTY_MOCK,
  instances: {
    owner: { mock: EMPTY_MOCK },
    hub: { mock: EMPTY_MOCK, extraConfig: hubHostConfig },
  },
  setup: (context) =>
    provisionHostToken(context, { write: false, waitFor: null }),
  steps: () => [
    {
      name: "read-token-command-failed-status",
      action: (client) =>
        waitForHost(
          client,
          "hub",
          "owner",
          "unreachable",
          "token_command_failed",
        ),
    },
  ],
});
