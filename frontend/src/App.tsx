import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import LoadingOverlay from "./LoadingOverlay";
import ConsolePage from "./Console";

import {
  type Msg,
  initToken,
  fetchMessages,
  postMessage,
  deleteMessage,
  createEventSource,
} from "./api";

type Active = {
  instanceId: string;
  msgId: string;
  icon: number;
  text: string;
  top: number;
  duration: number;
  delay: number;
};

// ====== 可调参数（不重叠关键）======
const LANES = 10;
const LANE_HEIGHT = 36;
const TOP_PADDING = 12;
const SPEED_PX_PER_SEC = 140;
const GAP_PX = 28;
// ==================================

function parseDeleteIds(input: string): string[] {
  const rest = input.slice("!delete".length).trim().replaceAll("，", ",");
  const parts = rest.split(",").map((s) => s.trim()).filter(Boolean);
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

function makeMeasurer() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  return (text: string, font: string) => {
    if (!ctx) return text.length * 10;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

export default function App() {
  // ✅ 简单路由：/wc/console 进入控制台（不启用弹幕逻辑）
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/wc/console") || path.endsWith("/console")) {
    return <ConsolePage />;
  }

  const [status, setStatus] = useState("init...");
  const [text, setText] = useState("");

  const [loading, setLoading] = useState(true);

  const poolRef = useRef<Map<string, Msg>>(new Map());
  const [active, setActive] = useState<Active[]>([]);

  const wallRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const laneNextMsRef = useRef<number[]>(
    Array.from({ length: LANES }, () => Date.now())
  );

  const measure = useMemo(() => makeMeasurer(), []);

  function getWallWidth() {
    const el = wallRef.current;
    return el ? el.clientWidth : 800;
  }

  function getDanmakuFont() {
    return "600 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  }

  function pickLane(now: number) {
    const next = laneNextMsRef.current;
    let best = 0;
    for (let i = 1; i < next.length; i++) {
      if (next[i] < next[best]) best = i;
    }
    const startAt = Math.max(now, next[best]);
    return { lane: best, startAt };
  }

  function spawn(msgId: string, forceImmediate = false) {
    const msg = poolRef.current.get(msgId);
    if (!msg) return;

    const now = Date.now();
    const wallW = getWallWidth();

    const font = getDanmakuFont();
    const measureText = `[${msg.id}] ${msg.content}`;
    const textW = measure(measureText, font);

    const travelPx = wallW + textW;
    const duration = Math.max(4, travelPx / SPEED_PX_PER_SEC);
    const gapTimeSec = (textW + GAP_PX) / SPEED_PX_PER_SEC;

    const { lane, startAt } = pickLane(now);
    const realStartAt = forceImmediate ? now : startAt;
    const delay = forceImmediate ? 0 : Math.max(0, (startAt - now) / 1000);

    laneNextMsRef.current[lane] = realStartAt + gapTimeSec * 1000;

    const top = TOP_PADDING + lane * LANE_HEIGHT;
    const instanceId = `${msgId}-${startAt}-${Math.random().toString(16).slice(2)}`;

    const icon = Math.floor(Math.random() * 20) + 1;

    setActive((prev) => [
      ...prev,
      { instanceId, msgId, icon, text: msg.content, top, duration, delay },
    ]);
  }

  function removeAllInstancesOf(msgId: string) {
    setActive((prev) => prev.filter((x) => x.msgId !== msgId));
  }

  function upsertToPoolAndSpawn(m: Msg) {
    poolRef.current.set(m.id, m);
    spawn(m.id);
  }

  function connectSSE() {
    esRef.current?.close();
    esRef.current = null;

    try {
      const es = createEventSource();
      esRef.current = es;

      es.onopen = () => setStatus("SSE connected");
      es.onerror = () => setStatus("SSE error (will retry on refresh)");

      es.addEventListener("hello", () => setStatus("SSE connected"));

      es.addEventListener("message", (e: MessageEvent) => {
        try {
          const m: Msg = JSON.parse(e.data);
          upsertToPoolAndSpawn(m);
        } catch {}
      });

      es.addEventListener("delete", (e: MessageEvent) => {
        try {
          const { id } = JSON.parse(e.data);
          poolRef.current.delete(id);
          removeAllInstancesOf(id);
        } catch {}
      });
    } catch (e) {
      setStatus(`SSE init failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    let alive = true;
    setStatus("booting...");

    (async () => {
      const tokenP = initToken().catch((e) => {
        console.log("initToken error:", e);
        if (alive) setStatus("过期啦！请重新扫码！");
      });

      const messagesP = fetchMessages()
        .then((init) => {
          if (!alive) return;

          poolRef.current.clear();
          for (const m of init) poolRef.current.set(m.id, m);

          setActive([]);
          laneNextMsRef.current = Array.from({ length: LANES }, () => Date.now());

          for (const m of init) spawn(m.id, true);
          if (alive) setStatus("messages loaded");
        })
        .catch((e) => {
          console.log("fetchMessages error:", e);
          if (alive) setStatus(`fail to fetch messages`);
        });

      await messagesP;
      await tokenP;

      if (!alive) return;

      setTimeout(() => {
        if (!alive) return;
        connectSSE();
      }, 800);
    })();

    return () => {
      alive = false;
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSend() {
    const v = text.trim();
    if (!v) return;

    if (v.startsWith("!delete")) {
      const ids = parseDeleteIds(v);
      if (ids.length === 0) {
        alert("请输入要删除的 id，例如：!delete Ab12Cd34,Ef56Gh78");
        return;
      }

      for (const id of ids) {
        try {
          const r = await deleteMessage(id);
          if (!r?.ok) alert(`删除失败(${id})：${r?.detail ?? "unknown"}`);
        } catch (e) {
          alert(`删除请求失败(${id})：${String(e)}`);
        }

        poolRef.current.delete(id);
        removeAllInstancesOf(id);
      }

      setText("");
      return;
    }

    try {
      const r = await postMessage(v);

      if (r?.ok && r?.item) {
        const m: Msg = r.item;
        upsertToPoolAndSpawn(m);
      } else {
        alert(`发送失败：${r?.detail ?? "unknown"}`);
        console.log("post failed:", r);
      }
    } catch (e) {
      alert(`发送请求失败：${String(e)}`);
    }

    setText("");
  }

  return (
    <>
      {loading && <LoadingOverlay onFinish={() => setLoading(false)} />}

      <div className="page">
        <div className="topbar">
          <div className="title">火辣辣弹幕~~~</div>
          <div className="status">{status}</div>
        </div>

        <div className="wall" ref={wallRef}>
          {active.map((a) => (
            <div
              key={a.instanceId}
              className="danmaku"
              style={{
                top: a.top,
                animationDuration: `${a.duration}s`,
                animationDelay: `${a.delay}s`,
              }}
              onAnimationEnd={() => {
                setActive((prev) => prev.filter((x) => x.instanceId !== a.instanceId));
                if (poolRef.current.has(a.msgId)) spawn(a.msgId);
              }}
              title={a.msgId}
            >
              <img className="icon" src={`${import.meta.env.BASE_URL}${a.icon}.png`} />
              <span>[{a.msgId}]</span>
              <span>{a.text}</span>
            </div>
          ))}
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
    </>
  );
}