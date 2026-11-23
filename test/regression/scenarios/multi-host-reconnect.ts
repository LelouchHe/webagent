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
  setup: (context) => provisionHostToken(context),
  steps: () => [
    {
      name: "restart-owner-and-wait-for-reconnect",
      async action(client) {
        const restart = await client.restart("owner", () =>
          client.waitForHost("hub", "owner", "unreachable"),
        );
        const status = await client.waitForHost("hub", "owner", "connected");
        return { restart, status };
      },
    },
  ],
});
