# utf-8
from __future__ import annotations

import asyncio
import os
import re
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
RECOVER_LIMIT = 1000
MAX_POSTS_PER_TOKEN = 5
RATE_LIMIT_PERIOD = 86400
# =======================

# ✅ 管理员 token（通过环境变量注入）
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()

# token -> expire_ts
_tokens: Dict[str, float] = {}

# 内存弹幕：id -> message
_messages: Dict[str, Dict[str, Any]] = {}
_order: List[str] = []

# SSE subscribers
_subscribers: set[asyncio.Queue] = set()
_sub_lock = asyncio.Lock()

# token限制发言次数
_token_counter: Dict[str, int] = {}
_token_last_reset: Dict[str, float] = {}

PID = os.getpid()
STARTUP_MS = now_ms()


def require_auth(authorization: Optional[str]) -> None:
    token = parse_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    exp = _tokens.get(token)
    if not exp or exp < now_ts():
        raise HTTPException(status_code=401, detail="Token expired")


def require_admin(authorization: Optional[str]) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Admin console disabled (ADMIN_TOKEN not set).")

    token = parse_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing admin token")

    if token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid admin token")


def check_and_update_token_limit(token: str) -> bool:
    now = now_ts()
    last_reset = _token_last_reset.get(token, 0)
    if now - last_reset >= RATE_LIMIT_PERIOD:
        _token_counter[token] = 0
        _token_last_reset[token] = now
        return True

    count = _token_counter.get(token, 0)
    if count >= MAX_POSTS_PER_TOKEN:
        return False

    _token_counter[token] = count + 1
    return True


def get_token_remaining(token: str) -> int:
    now = now_ts()
    last_reset = _token_last_reset.get(token, 0)

    if now - last_reset >= RATE_LIMIT_PERIOD:
        return MAX_POSTS_PER_TOKEN

    count = _token_counter.get(token, 0)
    return max(0, MAX_POSTS_PER_TOKEN - count)


_ID8_RE = re.compile(r"[A-Za-z0-9]{8}")


def parse_delete_ids(s: str) -> List[str]:
    ids = _ID8_RE.findall(s)
    seen = set()
    out = []
    for mid in ids:
        if mid not in seen:
            out.append(mid)
            seen.add(mid)
    return out


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
    t.put_item(Item={"id": msg["id"], "content": msg["content"], "ts": msg["ts"], "deleted": False})


def ddb_delete_item(mid: str) -> None:
    t = ddb_table()
    if t is None:
        return
    t.delete_item(Key={"id": mid})


def ddb_update_content(mid: str, content: str) -> None:
    t = ddb_table()
    if t is None:
        return
    t.update_item(
        Key={"id": mid},
        UpdateExpression="SET content = :c",
        ExpressionAttributeValues={":c": content},
    )


def ddb_recover() -> List[dict]:
    t = ddb_table()
    if t is None:
        return []
    items: List[dict] = []
    resp = t.scan()
    items.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = t.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))

    items = [x for x in items if not x.get("deleted", False)]
    items.sort(key=lambda x: int(x.get("ts", 0)))
    return items[-RECOVER_LIMIT:]


@asynccontextmanager
async def lifespan(app: FastAPI):
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
        print("DDB recover skipped:", repr(e))

    yield
    return


app = FastAPI(lifespan=lifespan)


# ---------- API models ----------
class PostMessageIn(BaseModel):
    content: str = Field(..., min_length=1)


class AdminUpdateMessageIn(BaseModel):
    content: str = Field(..., min_length=1)


class AdminBatchDeleteIn(BaseModel):
    ids: List[str] = Field(default_factory=list)


def _delete_local(mid: str) -> bool:
    existed = mid in _messages
    if existed:
        _messages.pop(mid, None)
        try:
            _order.remove(mid)
        except ValueError:
            pass
    return existed


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

    token = parse_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Invalid token")

    content = clean_text(payload.content)
    if not content:
        raise HTTPException(status_code=400, detail="Empty content")

    # delete 命令：不计入发言次数
    if content.startswith("!delete"):
        ids = parse_delete_ids(content)
        if not ids:
            raise HTTPException(status_code=400, detail="No ids to delete")

        results = []
        for mid in ids:
            resp = await delete_message(mid, authorization)
            results.append({"id": mid, "deleted": bool(resp.get("deleted", False))})

        return {"ok": True, "action": "delete", "ids": ids, "results": results}

    # 普通发言：限流
    if not check_and_update_token_limit(token):
        remaining = get_token_remaining(token)
        reset_in = RATE_LIMIT_PERIOD - int(now_ts() - _token_last_reset.get(token, 0))
        raise HTTPException(
            status_code=429,
            detail=f"发送次数已达上限（{MAX_POSTS_PER_TOKEN}条/24小时）",
            headers={
                "X-RateLimit-Limit": str(MAX_POSTS_PER_TOKEN),
                "X-RateLimit-Remaining": str(remaining),
                "X-RateLimit-Reset": str(reset_in),
            },
        )

    mid = gen_id8(set(_messages.keys()))
    msg = {"id": mid, "content": content, "ts": now_ms()}

    _messages[mid] = msg
    _order.append(mid)

    if len(_order) > MAX_IN_MEMORY:
        old = _order.pop(0)
        _messages.pop(old, None)

    try:
        ddb_put_message(msg)
    except Exception as e:
        print("DDB put failed:", msg["id"], repr(e))

    await broadcast("message", msg)

    remaining = get_token_remaining(token)
    return {"ok": True, "item": msg, "remaining": remaining}


@app.delete("/messages/{mid}")
async def delete_message(mid: str, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)

    existed = _delete_local(mid)

    try:
        ddb_delete_item(mid)
    except Exception as e:
        print("DDB delete failed:", mid, repr(e))

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


# =======================
# ✅ Admin console APIs
# =======================

@app.get("/admin/messages")
def admin_list_messages(authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)
    items = []
    for mid in _order:
        msg = _messages.get(mid)
        if msg:
            items.append(msg)
    return {"ok": True, "items": items}


@app.patch("/admin/messages/{mid}")
async def admin_update_message(mid: str, payload: AdminUpdateMessageIn, authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)

    content = clean_text(payload.content)
    if not content:
        raise HTTPException(status_code=400, detail="Empty content")

    msg = _messages.get(mid)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    msg["content"] = content

    try:
        ddb_update_content(mid, content)
    except Exception as e:
        print("DDB update failed:", mid, repr(e))

    await broadcast("message", msg)
    return {"ok": True, "item": msg}


@app.delete("/admin/messages/{mid}")
async def admin_delete_message(mid: str, authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)

    existed = _delete_local(mid)

    try:
        ddb_delete_item(mid)
    except Exception as e:
        print("DDB delete failed:", mid, repr(e))

    await broadcast("delete", {"id": mid})
    return {"ok": True, "deleted": existed}


@app.post("/admin/messages/batch-delete")
async def admin_batch_delete(payload: AdminBatchDeleteIn, authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)

    ids = []
    seen = set()
    for x in payload.ids:
        x = str(x).strip()
        if x and x not in seen:
            seen.add(x)
            ids.append(x)

    results = []
    for mid in ids:
        existed = _delete_local(mid)
        try:
            ddb_delete_item(mid)
        except Exception as e:
            print("DDB delete failed:", mid, repr(e))
        await broadcast("delete", {"id": mid})
        results.append({"id": mid, "deleted": existed})

    return {"ok": True, "results": results}


@app.exception_handler(HTTPException)
async def http_exc_handler(_, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": exc.detail})