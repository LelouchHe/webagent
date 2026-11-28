// Standalone SharedWorker entrypoint (bundled with splitting: false).
// Hosts the single SyncHub shared across all same-origin tabs.

import {
  SyncHub,
  type HubToTabMessage,
  type TabToHubMessage,
} from "./sync-hub.ts";

interface SharedWorkerGlobal {
  onconnect: ((event: MessageEvent) => void) | null;
}

const hub = new SyncHub();

const workerScope = self as unknown as SharedWorkerGlobal;
workerScope.onconnect = (event: MessageEvent) => {
  const port = event.ports.at(0);
  if (!port) return;
  const listeners: Array<(msg: TabToHubMessage) => void> = [];
  port.onmessage = (msgEvent: MessageEvent) => {
    const data = msgEvent.data as TabToHubMessage;
    for (const listener of listeners) listener(data);
  };
  port.start();
  hub.attach({
    postMessage(msg: HubToTabMessage) {
      port.postMessage(msg);
    },
    onMessage(handler) {
      listeners.push(handler);
    },
    close() {
      port.close();
    },
  });
};
