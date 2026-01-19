# utf-8
from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from utils import (
    clean_text,
    ddb_table,
    gen_id8,
    make_token,
    now_ms,
    now_ts,
    parse_bearer,
    sse,
)

# ========= 配置 =========
TOKEN_TTL_SECONDS = 5 * 60
MAX_IN_MEMORY = 500
RECOVER_LIMIT = 1000  # 重启时从DDB恢复多少条（按ts排序取最后N条）
# =======================

app = FastAPI()

# token -> expire_ts
_tokens: Dict[str, float] = {}

# 内存弹幕：id -> message
_messages: Dict[str, Dict[str, Any]] = {}
_order: List[str] = []

# SSE subscribers
_subscribers: set[asyncio.Queue] = set()
_sub_lock = asyncio.Lock()

# 命中的服务的标识
from utils import now_ms
PID = os.getpid()
STARTUP_MS = now_ms()

def require_auth(authorization: Optional[str]) -> None:
    token = parse_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    exp = _tokens.get(token)
    if not exp or exp < now_ts():
        raise HTTPException(status_code=401, detail="Token expired")


async def broadcast(event: str, data: dict) -> None:
    payload = {"event": event, "data": data}
    async with _sub_lock:
        dead: List[asyncio.Queue] = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            _subscribers.discard(q)


# ---------- DynamoDB ops ----------
def ddb_put_message(msg: dict) -> None:
    t = ddb_table()
    if t is None:
        return
    # PK = id（按你要求），其他字段随意
    t.put_item(Item={"id": msg["id"], "content": msg["content"], "ts": msg["ts"], "deleted": False})


def ddb_mark_delete(mid: str) -> None:
    t = ddb_table()
    if t is None:
        return
    # 这里选择“标记删除”，而不是 DeleteItem：
    # 方便重启恢复时知道它被删过（也能避免误恢复）
    t.update_item(
        Key={"id": mid},
        UpdateExpression="SET deleted = :d",
        ExpressionAttributeValues={":d": True},
    )


def ddb_recover() -> List[dict]:
    t = ddb_table()
    if t is None:
        return []
    # 轻量方案：scan 全表（活动弹幕量一般不大）
    # 如果未来量大，再改表设计/GSI/分区。
    items: List[dict] = []
    resp = t.scan()
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = t.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))

    # 只恢复未删除的
    items = [x for x in items if not x.get("deleted", False)]
    # 按ts排序取最后 N 条
    items.sort(key=lambda x: int(x.get("ts", 0)))
    return items[-RECOVER_LIMIT:]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动：尝试从DDB恢复到内存
    try:
        recovered = ddb_recover()
        _messages.clear()
        _order.clear()
        for it in recovered:
            mid = str(it["id"])
            msg = {"id": mid, "content": str(it.get("content", "")), "ts": int(it.get("ts", 0))}
            _messages[mid] = msg
            _order.append(mid)
    except Exception as e:
        # 开发期建议打印，方便你确认是不是权限/region/table问题
        print("DDB recover skipped:", repr(e))

    yield

    # 关机：这里暂时不需要做什么
    return

app = FastAPI(lifespan=lifespan)



# ---------- API ----------
class PostMessageIn(BaseModel):
    content: str = Field(..., min_length=1)


@app.get("/")
def root():
    return {"ok": True, "service": "danmaku-backend"}


@app.get("/token")
def issue_token():
    token = make_token()
    _tokens[token] = now_ts() + TOKEN_TTL_SECONDS
    return {"ok": True, "token": token, "expires_in": TOKEN_TTL_SECONDS}


@app.get("/messages")
def list_messages():
    items = []
    for mid in _order:
        msg = _messages.get(mid)
        if msg:
            items.append(msg)
    return {"ok": True, "items": items}


@app.post("/messages")
async def post_message(payload: PostMessageIn, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)

    content = clean_text(payload.content)
    if not content:
        raise HTTPException(status_code=400, detail="Empty content")

    # 兼容 "!delete id"
    if content.startswith("!delete "):
        target = content.split(" ", 1)[1].strip()
        return await delete_message(target, authorization)

    mid = gen_id8(set(_messages.keys()))
    msg = {"id": mid, "content": content, "ts": now_ms()}

    _messages[mid] = msg
    _order.append(mid)

    if len(_order) > MAX_IN_MEMORY:
        old = _order.pop(0)
        _messages.pop(old, None)

    try:
        ddb_put_message(msg)
    except Exception:
        # 不影响主流程
        pass

    await broadcast("message", msg)
    return {"ok": True, "item": msg}


@app.delete("/messages/{mid}")
async def delete_message(mid: str, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)

    existed = mid in _messages
    if existed:
        _messages.pop(mid, None)
        try:
            _order.remove(mid)
        except ValueError:
            pass

    try:
        ddb_mark_delete(mid)
    except Exception:
        pass

    await broadcast("delete", {"id": mid})
    return {"ok": True, "deleted": existed}


@app.get("/events")
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=200)

    async with _sub_lock:
        _subscribers.add(q)

    async def gen():
        yield sse("hello", {"ts": now_ms()})
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                    yield sse(item["event"], item["data"])
                except asyncio.TimeoutError:
                    yield sse("ping", {"ts": now_ms()})
        finally:
            async with _sub_lock:
                _subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.exception_handler(HTTPException)
async def http_exc_handler(_, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": exc.detail})
