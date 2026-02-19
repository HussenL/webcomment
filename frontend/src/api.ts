export type Msg = { id: string; content: string; ts: number };

// Vite: base="/wc/" -> import.meta.env.BASE_URL === "/wc/"
// 仍然保留 BASE 给静态资源用（你如果别处用到）
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// ✅ API 走根路径（由 CloudFront/ALB 统一转发）
const API_BASE = "";

let token: string | null = null;

export async function initToken() {
  const res = await fetch(`${API_BASE}/token`);
  if (!res.ok) {
    throw new Error(`initToken failed: ${res.status}`);
  }
  const data = await res.json();
  token = data.token;
}


function authHeaders(contentType?: string): Headers {
  const h = new Headers();
  if (contentType) h.set("Content-Type", contentType);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

export async function fetchMessages(): Promise<Msg[]> {
  const res = await fetch(`${API_BASE}/messages`);
  if (!res.ok) {
    throw new Error(`fetchMessages failed: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

export async function postMessage(content: string): Promise<any> {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`postMessage failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteMessage(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`deleteMessage failed: ${res.status}`);
  }
  return res.json();
}

export function createEventSource() {
  return new EventSource(`${API_BASE}/events`);
}
