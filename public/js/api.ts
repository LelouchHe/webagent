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
  return post("/api/v1/sessions", body);
}

export function deleteSession(id: string): Promise<void> {
  return request("/api/v1/sessions/" + id, { method: "DELETE" });
}

export function listSessions(): Promise<unknown[]> {
  return request("/api/v1/sessions");
}

export function getSession(id: string): Promise<Record<string, unknown>> {
  return request("/api/v1/sessions/" + id);
}

// --- Prompt ---

export function sendMessage(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string; path?: string }>): Promise<unknown> {
  const body: Record<string, unknown> = { text };
  if (images?.length) body.images = images;
  return post("/api/v1/sessions/" + sessionId + "/prompt", body);
}

// --- Cancel ---

export function cancelSession(sessionId: string): Promise<void> {
  return post("/api/v1/sessions/" + sessionId + "/cancel", {});
}

// --- Permissions ---

export function resolvePermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
  return post("/api/v1/sessions/" + sessionId + "/permissions/" + requestId, { optionId });
}

export function denyPermission(sessionId: string, requestId: string): Promise<void> {
  return post("/api/v1/sessions/" + sessionId + "/permissions/" + requestId, { denied: true });
}

// --- Config ---

export function setConfig(sessionId: string, configId: string, value: string): Promise<void> {
  const urlId = configId.replace(/_/g, "-");
  return request("/api/v1/sessions/" + sessionId + "/" + urlId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function setTitle(sessionId: string, title: string): Promise<void> {
  return request("/api/v1/sessions/" + sessionId + "/title", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: title }),
  });
}

// --- Bash ---

export function execBash(sessionId: string, command: string): Promise<unknown> {
  return post("/api/v1/sessions/" + sessionId + "/bash", { command });
}

export function cancelBash(sessionId: string): Promise<void> {
  return post("/api/v1/sessions/" + sessionId + "/bash/cancel", {});
}

// --- Visibility ---

export function postVisibility(clientId: string, visible: boolean, sessionId?: string): Promise<void> {
  const body: Record<string, unknown> = { visible };
  if (sessionId) body.sessionId = sessionId;
  return post("/api/beta/clients/" + clientId + "/visibility", body);
}

// --- Status ---

export function getStatus(sessionId: string): Promise<Record<string, unknown>> {
  return request("/api/v1/sessions/" + sessionId + "/status");
}
