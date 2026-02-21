import { useEffect, useMemo, useState } from "react";
import "./Console.css";
import {
  type Msg,
  adminFetchAllMessages,
  adminBatchDelete,
  adminDeleteMessage,
  adminUpdateMessage,
  getAdminToken,
  setAdminToken,
} from "./api";

function fmt(ts: number) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function ConsolePage() {
  const [status, setStatus] = useState("console init...");
  const [adminToken, setAdminTokenState] = useState(getAdminToken());

  const [items, setItems] = useState<Msg[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [edit, setEdit] = useState<Record<string, string>>({});

  const selectedIds = useMemo(
    () => Object.entries(checked).filter(([, v]) => v).map(([id]) => id),
    [checked]
  );

  async function refresh() {
    try {
      setStatus("loading...");
      const data = await adminFetchAllMessages();
      data.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
      setItems(data);

      const m: Record<string, string> = {};
      for (const x of data) m[x.id] = x.content;
      setEdit(m);

      setChecked({});
      setStatus(`loaded: ${data.length}`);
    } catch (e) {
      setStatus(`load failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (adminToken.trim()) refresh();
    else setStatus("请输入 ADMIN_TOKEN 后点击保存，再刷新");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSaveToken() {
    setAdminToken(adminToken);
    setStatus("token saved, click refresh");
  }

  async function onDeleteOne(id: string) {
    if (!confirm(`删除 ${id} ?`)) return;
    try {
      setStatus(`deleting ${id}...`);
      await adminDeleteMessage(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      setChecked((prev) => {
        const p = { ...prev };
        delete p[id];
        return p;
      });
      setStatus(`deleted ${id}`);
    } catch (e) {
      setStatus(`delete failed: ${String(e)}`);
    }
  }

  async function onSaveOne(id: string) {
    const content = (edit[id] ?? "").trim();
    if (!content) {
      alert("内容不能为空");
      return;
    }
    try {
      setStatus(`saving ${id}...`);
      await adminUpdateMessage(id, content);
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, content } : x)));
      setStatus(`saved ${id}`);
    } catch (e) {
      setStatus(`save failed: ${String(e)}`);
    }
  }

  async function onBatchDelete() {
    if (selectedIds.length === 0) {
      alert("请先勾选要删除的消息");
      return;
    }
    if (!confirm(`批量删除 ${selectedIds.length} 条？`)) return;

    try {
      setStatus(`batch deleting ${selectedIds.length}...`);
      await adminBatchDelete(selectedIds);
      setItems((prev) => prev.filter((x) => !selectedIds.includes(x.id)));
      setChecked({});
      setStatus(`batch deleted: ${selectedIds.length}`);
    } catch (e) {
      setStatus(`batch delete failed: ${String(e)}`);
    }
  }

  return (
    <div className="console-page">
      <div className="console-topbar">
        <div className="console-title">控制台</div>
        <div className="console-status">{status}</div>
      </div>

      <div className="console-tools">
        <input
          className="console-token"
          value={adminToken}
          onChange={(e) => setAdminTokenState(e.target.value)}
          placeholder="输入 ADMIN_TOKEN（只保存在本机 localStorage）"
        />
        <button onClick={onSaveToken}>保存Token</button>
        <button onClick={refresh}>刷新</button>
        <button onClick={onBatchDelete} disabled={selectedIds.length === 0}>
          批量删除（{selectedIds.length}）
        </button>

        <a className="console-back" href="/wc/">
          回到弹幕墙
        </a>
      </div>

      <div className="console-table-wrap">
        <table className="console-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}></th>
              <th style={{ width: 120 }}>ID</th>
              <th style={{ width: 170 }}>时间</th>
              <th>内容</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={!!checked[x.id]}
                    onChange={(e) =>
                      setChecked((prev) => ({ ...prev, [x.id]: e.target.checked }))
                    }
                  />
                </td>
                <td className="mono">{x.id}</td>
                <td className="mono">{fmt(x.ts)}</td>
                <td>
                  <textarea
                    className="console-textarea"
                    value={edit[x.id] ?? ""}
                    onChange={(e) =>
                      setEdit((prev) => ({ ...prev, [x.id]: e.target.value }))
                    }
                  />
                </td>
                <td>
                  <div className="console-actions">
                    <button onClick={() => onSaveOne(x.id)}>保存</button>
                    <button className="danger" onClick={() => onDeleteOne(x.id)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="console-empty">
                  暂无数据（或 token 不正确 / nginx 未转发 /admin）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}