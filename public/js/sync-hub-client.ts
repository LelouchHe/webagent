// SharedWorker startup (ready-gated) with transparent single fallback to
// in-Tab SyncHub + DirectPort and fallback keepalive visibility beacon.

import {
  SyncHub,
  createDirectPortPair,
  type HubToTabMessage,
  type TabToHubMessage,
} from "./sync-hub.ts";
import { getStoredToken } from "./auth-fetch.ts";
import { log } from "./log.ts";

const clog = log.scope("sse");
const WORKER_READY_TIMEOUT_MS = 2_000;

export interface TabPortClient {
  postMessage(msg: TabToHubMessage): void;
  close(): void;
}

export interface HubClientSession {
  readonly port: TabPortClient;
  readonly fallbackHub: SyncHub | null;
  dispose(): void;
}

function getWorkerScriptUrl(): string | null {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="webagent-sync-worker"]',
  );
  const content = meta?.content ?? "";
  return content.length > 0 ? content : null;
}

export function connectToSyncHub(callbacks: {
  onReady(port: TabPortClient, fallbackHub: SyncHub | null): void;
  onMessage(msg: HubToTabMessage): void;
}): { dispose(): void } {
  let disposed = false;
  let fallbackHub: SyncHub | null = null;
  let activePort: TabPortClient | null = null;

  const startFallback = (): void => {
    if (disposed || fallbackHub) return;
    const hub = new SyncHub();
    fallbackHub = hub;
    const { hubPort, tabPort } = createDirectPortPair();
    const client: TabPortClient = {
      postMessage: (m) => {
        tabPort.postMessage(m);
      },
      close: () => {},
    };
    activePort = client;
    tabPort.onMessage((msg) => {
      if (disposed) return;
      if (msg.type === "ready") {
        callbacks.onReady(client, hub);
        return;
      }
      callbacks.onMessage(msg);
    });
    hub.attach(hubPort);
  };

  const workerUrl = getWorkerScriptUrl();
  if (typeof SharedWorker !== "function" || !workerUrl) {
    startFallback();
  } else {
    let settled = false;
    let worker: SharedWorker | null = null;
    try {
      worker = new SharedWorker(workerUrl, {
        type: "module",
        name: "webagent-sync",
      });
    } catch {
      startFallback();
    }
    if (worker) {
      const port = worker.port;
      const readyTimer = setTimeout(() => {
        if (settled || disposed) return;
        settled = true;
        port.onmessage = null;
        port.close();
        clog.warn(
          "SharedWorker ready timed out; falling back to direct SyncHub",
        );
        startFallback();
      }, WORKER_READY_TIMEOUT_MS);

      worker.onerror = () => {
        if (settled || disposed) return;
        settled = true;
        clearTimeout(readyTimer);
        port.onmessage = null;
        port.close();
        clog.warn(
          "SharedWorker failed to load; falling back to direct SyncHub",
        );
        startFallback();
      };

      port.onmessage = (event: MessageEvent) => {
        if (disposed) return;
        const msg = event.data as HubToTabMessage;
        if (!settled) {
          if (msg.type !== "ready") return;
          settled = true;
          clearTimeout(readyTimer);
          const client: TabPortClient = {
            postMessage: (m) => {
              port.postMessage(m);
            },
            close: () => {
              port.close();
            },
          };
          activePort = client;
          callbacks.onReady(client, null);
          return;
        }
        callbacks.onMessage(msg);
      };
      port.start();
    }
  }

  return {
    dispose() {
      disposed = true;
      fallbackHub?.dispose();
      fallbackHub = null;
      activePort?.close();
      activePort = null;
    },
  };
}

export function postFallbackClearVisibilityBeacon(
  fallbackHub: SyncHub | null,
): void {
  if (!fallbackHub) return;
  const clientId = fallbackHub.getClientId();
  const token = getStoredToken();
  if (!clientId || !token) return;
  const rev = fallbackHub.nextVisibilityRev();
  const url = `/api/beta/clients/${encodeURIComponent(clientId)}/visibility`;
  try {
    void fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Visibility-Rev": String(rev),
      },
      body: JSON.stringify({ taskIds: [] }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
