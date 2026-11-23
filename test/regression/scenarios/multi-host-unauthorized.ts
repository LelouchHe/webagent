import { scenario } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  type ProvisionedHostToken,
} from "../multi-host.ts";

export default scenario<ProvisionedHostToken>({
  mock: EMPTY_MOCK,
  instances: {
    owner: { mock: EMPTY_MOCK },
    hub: { mock: EMPTY_MOCK, extraConfig: hubHostConfig },
  },
  setup: (context) =>
    provisionHostToken(context, (token) => `${token}-wrong`, true, false),
  steps: () => [
    {
      name: "read-unauthorized-status",
      action: (client) =>
        client.waitForHost("hub", "owner", "unreachable", "unauthorized"),
    },
  ],
});
