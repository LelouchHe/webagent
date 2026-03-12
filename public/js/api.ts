// REST API client for all server communication.
// Replaces WebSocket message sends with typed fetch calls.

export class ApiError extends Error {
  name = "ApiError";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as Record<string, unknown>;
      if (body.error) message = String(body.error);
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function post<T = unknown>(url: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Session CRUD ---

export function createSession(opts?: { cwd?: string; inheritFromSessionId?: string | null }): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (opts?.cwd) body.cwd = opts.cwd;
  if (opts?.inheritFromSessionId) body.inheritFromSessionId = opts.inheritFromSessionId;
  return post("/api/sessions", body);
}

export function deleteSession(id: string): Promise<void> {
  return request("/api/sessions/" + id, { method: "DELETE" });
}

export function listSessions(): Promise<unknown[]> {
  return request("/api/sessions");
}

export function getSession(id: string): Promise<Record<string, unknown>> {
  return request("/api/sessions/" + id);
}

// --- Prompt ---

export function sendMessage(sessionId: string, text: string, images?: Array<{ url: string }>): Promise<unknown> {
  const body: Record<string, unknown> = { text };
  if (images?.length) body.images = images;
  return post("/api/sessions/" + sessionId + "/messages", body);
}

// --- Cancel ---

export function cancelSession(sessionId: string): Promise<void> {
  return post("/api/sessions/" + sessionId + "/cancel", {});
}

// --- Permissions ---

export function resolvePermission(requestId: string, optionId: string): Promise<void> {
  return post("/api/permissions/" + requestId, { optionId });
}

// --- Config ---

export function setConfig(sessionId: string, configId: string, value: string): Promise<void> {
  return request("/api/sessions/" + sessionId, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configId, value }),
  });
}

// --- Bash ---

export function execBash(sessionId: string, command: string): Promise<unknown> {
  return post("/api/sessions/" + sessionId + "/bash", { command });
}

export function cancelBash(sessionId: string): Promise<void> {
  return post("/api/sessions/" + sessionId + "/bash/cancel", {});
}

// --- Visibility ---

export function postVisibility(clientId: string, visible: boolean): Promise<void> {
  return post("/api/clients/" + clientId + "/visibility", { visible });
}

// --- Status ---

export function getStatus(sessionId: string): Promise<Record<string, unknown>> {
  return request("/api/sessions/" + sessionId + "/status");
}
