import { scenario } from "../types.ts";
import {
  EMPTY_MOCK,
  hubHostConfig,
  provisionHostToken,
  readHostToken,
  type ProvisionedHostToken,
} from "../multi-host.ts";

export default scenario<ProvisionedHostToken>({
  mock: EMPTY_MOCK,
  instances: {
    owner: { mock: EMPTY_MOCK },
    hub: { mock: EMPTY_MOCK, extraConfig: hubHostConfig },
  },
  setup: (context) => provisionHostToken(context),
  steps: (_client, state) => [
    {
      name: "describe-owner-and-read-hub-status",
      action: (client) =>
        Promise.all([
          client
            .instance("owner")
            .rest(
              "GET",
              "/api/v1/auth/verify",
              undefined,
              readHostToken(state),
            ),
          client.instance("owner").rest("GET", "/api/v1/version"),
          client.instance("hub").rest("GET", "/api/v1/hosts"),
        ]),
    },
  ],
});
