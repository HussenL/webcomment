from __future__ import annotations

import json
import secrets
import string
import time
import os
from typing import Optional

import boto3


def now_ts() -> float:
    return time.time()


def now_ms() -> int:
    return int(now_ts() * 1000)


def clean_text(s: str) -> str:
    # 轻度清理：按你需求不做长度限制、不做去重
    return s.strip()


def gen_id8(existing: set[str]) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        mid = "".join(secrets.choice(alphabet) for _ in range(8))
        if mid not in existing:
            return mid


def make_token() -> str:
    return secrets.token_urlsafe(24)


def parse_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        return None
    return authorization.removeprefix("Bearer ").strip() or None


def sse(event: str, data: dict) -> str:
    # SSE 标准格式：event + data(JSON) + 空行分隔
    return f"event: {event}\n" f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------- DynamoDB helpers ----------------
AWS_REGION = os.getenv("AWS_REGION", "ap-northeast-2")
DDB_TABLE = os.getenv("DDB_TABLE", "DanmakuMessages")
DDB_ENABLED = os.getenv("DDB_ENABLED", "1") == "1"

# 可选：本地 DynamoDB（如果你用 dynamodb-local）
# export DDB_ENDPOINT_URL=http://127.0.0.1:8001
DDB_ENDPOINT_URL = os.getenv("DDB_ENDPOINT_URL")

_ddb = None
_table = None


def ddb_table():
    """延迟初始化，避免本地没配 AWS 凭证就直接炸。"""
    global _ddb, _table
    if not DDB_ENABLED:
        return None
    if _table is not None:
        return _table

    kwargs = {"region_name": AWS_REGION}
    if DDB_ENDPOINT_URL:
        kwargs["endpoint_url"] = DDB_ENDPOINT_URL

    _ddb = boto3.resource("dynamodb", **kwargs)
    _table = _ddb.Table(DDB_TABLE)
    return _table