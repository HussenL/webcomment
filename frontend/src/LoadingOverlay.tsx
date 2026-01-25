import { useEffect, useState } from "react";
import "./LoadingOverlay.css";

type Icon = {
  id: number;
  x: number;
  y: number;
  scale: number;
};

const ICON_COUNT = 20;
const BASE = import.meta.env.BASE_URL;

// 生成一个“全屏随机”的 icon
function createIcon(): Icon {
  return {
    id: Math.floor(Math.random() * ICON_COUNT) + 1,
    x: Math.random() * 100,
    y: Math.random() * 100,
    scale: 0.7 + Math.random() * 0.9,
  };
}

export default function LoadingOverlay({
  onFinish,
}: {
  onFinish: () => void;
}) {
  const [icons, setIcons] = useState<Icon[]>([]);
  const [phase, setPhase] = useState<"fill" | "fall">("fill");

  useEffect(() => {
    let fillTimer: number | null = null;

    /* ========= Phase：全屏持续生长（~2.5s，到 200 个） ========= */
    fillTimer = window.setInterval(() => {
      setIcons((prev) => {
        if (prev.length >= 200) return prev;
        const batch = Array.from({ length: 14 }, () => createIcon());
        return [...prev, ...batch];
      });
    }, 70); // 生长速度：越小越“爆”

    /* ========= Phase：下落 ========= */
    const t1 = window.setTimeout(() => {
      if (fillTimer) window.clearInterval(fillTimer);
      setPhase("fall");
    }, 2500);

    /* ========= 完成 ========= */
    const t2 = window.setTimeout(() => {
      onFinish();
    }, 3300);

    return () => {
      if (fillTimer) window.clearInterval(fillTimer);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onFinish]);

  return (
    <div className={`loading-overlay phase-${phase}`}>
      {icons.map((icon, i) => (
        <img
          key={i}
          className="loading-icon"
          src={`${BASE}${icon.id}.png`}
          alt=""
          draggable={false}
          style={{
            left: `${icon.x}vw`,
            top: `${icon.y}vh`,
            transform: `translate(-50%, -50%) scale(${icon.scale})`,
          }}
        />
      ))}
    </div>
  );
}
