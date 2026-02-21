export type Msg = { id: string; content: string; ts: number };

// ✅ 统一走 /wc 前缀（命中 CloudFront 的 /wc* 行为）
const API_BASE = "/wc";

let token: string | null = null;

// ===== 普通用户 token（短期）=====
export async function initToken() {
  const res = await fetch(`${API_BASE}/token`);
  if (!res.ok) throw new Error(`initToken failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`fetchMessages failed: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function postMessage(content: string): Promise<any> {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`postMessage failed: ${res.status}`);
  return res.json();
}

export async function deleteMessage(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`deleteMessage failed: ${res.status}`);
  return res.json();
}

export function createEventSource() {
  return new EventSource(`${API_BASE}/events`);
}

// ===== Admin（console）=====
const ADMIN_KEY = "wc_admin_token";

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_KEY) ?? "";
}

export function setAdminToken(v: string) {
  localStorage.setItem(ADMIN_KEY, v.trim());
}

function adminHeaders(contentType?: string): Headers {
  const h = new Headers();
  if (contentType) h.set("Content-Type", contentType);

  const t = getAdminToken();
  if (t) h.set("Authorization", `Bearer ${t}`);
  return h;
}

// ✅ 注意：管理 API 也走 /wc/admin/*
export async function adminFetchAllMessages(): Promise<Msg[]> {
  const res = await fetch(`${API_BASE}/admin/messages`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`adminFetchAllMessages failed: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function adminUpdateMessage(id: string, content: string): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: adminHeaders("application/json"),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`adminUpdateMessage failed: ${res.status}`);
  return res.json();
}

export async function adminDeleteMessage(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`adminDeleteMessage failed: ${res.status}`);
  return res.json();
}

export async function adminBatchDelete(ids: string[]): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/messages/batch-delete`, {
    method: "POST",
    headers: adminHeaders("application/json"),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`adminBatchDelete failed: ${res.status}`);
  return res.json();
}