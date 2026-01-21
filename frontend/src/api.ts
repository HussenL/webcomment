let token: string | null = null;

export async function initToken() {
  const res = await fetch("/token");
  const data = await res.json();
  token = data.token;
}

function buildHeaders(contentType?: string): Headers {
  const h = new Headers();
  if (contentType) h.set("Content-Type", contentType);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

export async function fetchMessages() {
  const res = await fetch("/messages");
  return res.json();
}

export async function postMessage(content: string) {
  const res = await fetch("/messages", {
    method: "POST",
    headers: buildHeaders("application/json"),
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function deleteMessage(id: string) {
  const res = await fetch(`/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return res.json();
}
