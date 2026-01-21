import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type Msg = { id: string; content: string; ts: number };

let token: string | null = null;

async function initToken() {
  const res = await fetch("/token");
  const data = await res.json();
  token = data.token;
}

function authHeaders(contentType?: string): Headers {
  const h = new Headers();
  if (contentType) h.set("Content-Type", contentType);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function fetchMessages(): Promise<Msg[]> {
  const res = await fetch("/messages");
  const data = await res.json();
  return data.items ?? [];
}

async function postMessage(content: string): Promise<any> {
  const res = await fetch("/messages", {
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ content }),
  });
  return res.json();
}

async function deleteMessage(id: string): Promise<any> {
  const res = await fetch(`/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}

function parseDeleteIds(input: string): string[] {
  // 支持 "!delete a,b,c"（也容错中文逗号/多空格）
  const rest = input.slice("!delete".length).trim().replaceAll("，", ",");
  const parts = rest.split(",").map((s) => s.trim()).filter(Boolean);

  // 去重但保序
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      ids.push(p);
    }
  }
  return ids;
}

export default function App() {
  const [items, setItems] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string>("init...");
  const lanes = useMemo(() => 10, []);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        await initToken();
        if (!alive) return;

        const init = await fetchMessages();
        if (!alive) return;
        setItems(init);

        const es = new EventSource("/events");
        esRef.current = es;

        es.onopen = () => setStatus("SSE connected");
        es.onerror = () => setStatus("SSE error (check backend/proxy)");

        es.addEventListener("message", (e: MessageEvent) => {
          const msg: Msg = JSON.parse(e.data);
          setItems((prev) => [...prev, msg]);
        });

        es.addEventListener("delete", (e: MessageEvent) => {
          const { id } = JSON.parse(e.data);
          setItems((prev) => prev.filter((x) => x.id !== id));
        });

        es.addEventListener("hello", () => setStatus("SSE connected"));
      } catch (e) {
        console.log("init error:", e);
        setStatus(String(e));
      }
    })();

    return () => {
      alive = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  async function onSend() {
    const v = text.trim();
    if (!v) return;

    // ✅ delete command（批量）
    if (v.startsWith("!delete")) {
      const ids = parseDeleteIds(v);
      if (ids.length === 0) {
        alert("请输入要删除的 id，例如：!delete Ab12Cd34,Ef56Gh78");
        return;
      }

      for (const id of ids) {
        const r = await deleteMessage(id);
        if (!r?.ok) alert(`删除失败(${id})：${r?.detail ?? "unknown"}`);
        // 本地立即删（不依赖 SSE）
        setItems((prev) => prev.filter((x) => x.id !== id));
      }

      setText("");
      return;
    }

    // ✅ normal message
    const r = await postMessage(v);

    if (r?.ok && r?.item) {
      // POST 成功立即显示，不依赖 SSE
      setItems((prev) => [...prev, r.item]);
    } else {
      alert(`发送失败：${r?.detail ?? "unknown"}`);
      console.log("post failed:", r);
    }

    setText("");
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="title">Danmaku</div>
        <div className="status">{status}</div>
      </div>

      <div className="wall">
        {items.map((m) => {
          const lane = (hash(m.id) % lanes + lanes) % lanes;
          const top = 12 + lane * 36;
          const duration = 10 + (hash(m.id + "x") % 6);

          return (
            <div
              key={m.id}
              className="danmaku"
              style={{ top, animationDuration: `${duration}s` }}
              title={m.id}
            >
              <span className="id">[{m.id}]</span> {m.content}
            </div>
          );
        })}
      </div>

      <div className="bar">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入弹幕"
          onKeyDown={(e) => e.key === "Enter" && onSend()}
        />
        <button onClick={onSend}>发送</button>
      </div>
    </div>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
