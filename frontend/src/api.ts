let token: string | null = null;

export async function initToken() {
  const res = await fetch("/token");
  const data = await res.json();
  token = data.token;
}

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchMessages() {
  const res = await fetch("/messages");
  return res.json();
}

export async function postMessage(content: string) {
  const res = await fetch("/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function deleteMessage(id: string) {
  const res = await fetch(`/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return res.json();
}
