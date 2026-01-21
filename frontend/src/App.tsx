import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

import {
  type Msg,
  initToken,
  fetchMessages,
  postMessage,
  deleteMessage,
  createEventSource,
} from "./api";

type Active = {
  instanceId: string; // 每次“发射”的实例 id（用于循环）
  msgId: string;      // 逻辑弹幕 id（后端 id）
  text: string;       // 显示文本（含 [id]）
  top: number;        // px
  duration: number;   // seconds
  delay: number;      // seconds
};

// ====== 可调参数（不重叠关键）======
const LANES = 10;
const LANE_HEIGHT = 36;         // 每行高度
const TOP_PADDING = 12;         // 第一行距离顶部
const SPEED_PX_PER_SEC = 140;   // 弹幕速度（越大越快）
const GAP_PX = 28;              // 同一行弹幕最小间距（像素）
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

// 用 canvas 粗略测量弹幕宽度（比“按字符数估算”更准）
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
  const [status, setStatus] = useState("init...");
  const [text, setText] = useState("");

  // pool：当前“存在的弹幕”（未删除）
  const poolRef = useRef<Map<string, Msg>>(new Map());

  // active：当前在屏幕上飞的“实例”（循环会不断生成新的实例）
  const [active, setActive] = useState<Active[]>([]);

  const wallRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // 每条 lane 下一次允许发射的时间点（ms）
  const laneNextMsRef = useRef<number[]>(Array.from({ length: LANES }, () => Date.now()));

  // 测量函数（只创建一次）
  const measure = useMemo(() => makeMeasurer(), []);

  function getWallWidth() {
    const el = wallRef.current;
    return el ? el.clientWidth : 800;
  }

  function getDanmakuFont() {
    // 尽量与 CSS 的 .danmaku 保持一致
    // 如果你改了 App.css 里的字体/字号，这里也对应改一下即可
    return "600 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  }

  // 选择最早可发射的 lane（最不容易重叠）
  function pickLane(now: number) {
    const next = laneNextMsRef.current;
    let best = 0;
    for (let i = 1; i < next.length; i++) {
      if (next[i] < next[best]) best = i;
    }
    const startAt = Math.max(now, next[best]); // 可能需要延迟
    return { lane: best, startAt };
  }

  function spawn(msgId: string, forceImmediate = false) {
    const msg = poolRef.current.get(msgId);
    if (!msg) return;

    const now = Date.now();
    const wallW = getWallWidth();

    const displayText = `[${msg.id}] ${msg.content}`;
    const font = getDanmakuFont();
    const textW = measure(displayText, font);

    // 固定速度：duration = (路程长度) / speed
    // 路程近似为：墙宽 + 文本宽
    const travelPx = wallW + textW;
    const duration = Math.max(4, travelPx / SPEED_PX_PER_SEC); // 至少 4s，避免太快

    // 同 lane 防追尾：下一条至少在“间距时间”之后才能发射
    const gapTimeSec = (textW + GAP_PX) / SPEED_PX_PER_SEC;

    const { lane, startAt } = pickLane(now);
    const realStartAt = forceImmediate ? now : startAt;
    const delay = forceImmediate ? 0 : Math.max(0, (startAt - now) / 1000);

    // 更新该 lane 的下次可发射时间
    laneNextMsRef.current[lane] = realStartAt + gapTimeSec * 1000;

    const top = TOP_PADDING + lane * LANE_HEIGHT;

    const instanceId = `${msgId}-${startAt}-${Math.random().toString(16).slice(2)}`;

    setActive((prev) => [
      ...prev,
      { instanceId, msgId, text: displayText, top, duration, delay },
    ]);
  }

  function removeAllInstancesOf(msgId: string) {
    setActive((prev) => prev.filter((x) => x.msgId !== msgId));
  }

  function upsertToPoolAndSpawn(m: Msg) {
    poolRef.current.set(m.id, m);
    spawn(m.id);
  }

  // 初始化 + SSE
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        await initToken();
        if (!alive) return;

        const init = await fetchMessages();
        if (!alive) return;

        // 写入 pool
        poolRef.current.clear();
        for (const m of init) poolRef.current.set(m.id, m);

        // 清空 active，并把初始化弹幕“发射一轮”
        setActive([]);
        laneNextMsRef.current = Array.from({ length: LANES }, () => Date.now());
        for (const m of init) spawn(m.id, true);

        // SSE
        const es = createEventSource();
        esRef.current = es;

        es.onopen = () => setStatus("SSE connected");
        es.onerror = () => setStatus("SSE error (check backend/proxy)");

        es.addEventListener("hello", () => setStatus("SSE connected"));

        es.addEventListener("message", (e: MessageEvent) => {
          const m: Msg = JSON.parse(e.data);
          upsertToPoolAndSpawn(m);
        });

        es.addEventListener("delete", (e: MessageEvent) => {
          const { id } = JSON.parse(e.data);
          poolRef.current.delete(id);
          removeAllInstancesOf(id);
        });
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

    // 批量删除
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
        poolRef.current.delete(id);
        removeAllInstancesOf(id);
      }

      setText("");
      return;
    }

    const r = await postMessage(v);

    if (r?.ok && r?.item) {
      const m: Msg = r.item;
      upsertToPoolAndSpawn(m); // 不依赖 SSE，立即显示
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
              // 该实例飞完，移除
              setActive((prev) => prev.filter((x) => x.instanceId !== a.instanceId));

              // 如果该弹幕仍存在于 pool（未被删除），则再次发射（循环播放）
              if (poolRef.current.has(a.msgId)) {
                spawn(a.msgId);
              }
            }}
            title={a.msgId}
          >
            {a.text}
          </div>
        ))}
      </div>

      <div className="bar">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='输入弹幕'
          onKeyDown={(e) => e.key === "Enter" && onSend()}
        />
        <button onClick={onSend}>发送</button>
      </div>
    </div>
  );
}
