"""激活中心 Activation Console - Cloudflare Python Workers (FastAPI) 版

迁移自：
  - FastAPI 版（Windows 4600U:8400）main.py
  - Cloudflare JS Worker 版 src/index.js
存储：D1(SQLite) 数据 + KV(SESSIONS) 登录会话，接口与两版 /api/v1 完全一致。
"""
import hashlib
import hmac
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

API_PREFIX = "/api/v1"
SESSION_TTL = 86400  # 秒


def now_ts() -> str:
    """与 JS 版一致：UTC 'YYYY-MM-DD HH:MM:SS'"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------- 绑定访问 ----------
def _db(request: Request):
    return request.scope["env"].DB


def _kv(request: Request):
    return request.scope["env"].SESSIONS


def _ip(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or ""


async def _settings(request: Request) -> dict:
    r = await _db(request).prepare("SELECT key, value FROM settings").all()
    return {row.key: row.value for row in r.results}


async def _set_setting(request: Request, key: str, value: str):
    await (
        _db(request)
        .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(key, value)
        .run()
    )


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _hmac_eq(a: str, b: str) -> bool:
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


async def _op_record(request: Request, action: str, detail: str):
    await (
        _db(request)
        .prepare("INSERT INTO op_logs(operator,action,detail,client_ip) VALUES('admin',?,?,?)")
        .bind(action, detail, _ip(request))
        .run()
    )


async def _check_record(request: Request, code: str, result: int, msg: str):
    ip = _ip(request)
    await (
        _db(request)
        .prepare("INSERT INTO check_logs(project_code,client_ip,result,message) VALUES(?,?,?,?)")
        .bind(code, ip, result, msg)
        .run()
    )
    await (
        _db(request)
        .prepare("UPDATE projects SET last_check_at=datetime('now'), last_status=?, client_ip=?, status=? WHERE project_code=?")
        .bind("通过" if result else "拒绝", ip, "running" if result else "stopped", code)
        .run()
    )


def _row_to_dict(row, fields: tuple, bools: tuple = ()):
    d = {}
    for f in fields:
        v = getattr(row, f, None)
        if f in bools:
            v = bool(v)
        d[f] = v
    return d


PROJ_FIELDS = (
    "id", "project_code", "name", "group_id", "description", "status",
    "is_activate", "client_ip", "last_check_at", "last_status", "created_at",
    "group_name",
)


async def admin_ok(request: Request) -> bool:
    tok = request.headers.get("x-token") or ""
    if not tok:
        return False
    return bool(await _kv(request).get(tok))


async def auth_dep(request: Request):
    if not await admin_ok(request):
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return True


# ---------- 模型 ----------
class LoginIn(BaseModel):
    password: str


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    remark: str = ""


class ProjectAdd(BaseModel):
    project_code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    group_id: int = 0
    description: str = ""
    is_activate: bool = True


class ProjectStatusIn(BaseModel):
    id: Optional[int] = None
    project_code: Optional[str] = None
    is_activate: bool = True


class SettingsIn(BaseModel):
    old_password: Optional[str] = None
    new_password: Optional[str] = None
    rotate_auth_key: Optional[bool] = False


# ---------- 应用 ----------
app = FastAPI(title="激活中心", docs_url=None, openapi_url=None)


@app.exception_handler(HTTPException)
async def http_exc(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code,
                        content={"code": exc.status_code, "msg": exc.detail, "data": None})


def ok(data=None, msg="success"):
    return {"code": 0, "msg": msg, "data": data}


# ---------- 健康 ----------
@app.get("/health")
async def health():
    return ok({"status": "ok", "service": "activate-center", "time": now_ts()})


# ---------- 登录 / 登出 ----------
@app.post(f"{API_PREFIX}/login")
async def login(body: LoginIn, request: Request):
    s = await _settings(request)
    if not _hmac_eq(_sha256(body.password), s.get("password_hash") or ""):
        await _op_record(request, "登录失败", "密码错误")
        raise HTTPException(401, "密码错误")
    tok = "S-" + secrets.token_hex(24)
    await _kv(request).put(tok, "1", {"expirationTtl": SESSION_TTL})
    await _op_record(request, "登录成功", "admin 登录控制台")
    return ok({"token": tok, "user": s.get("admin_user") or "admin"})


@app.post(f"{API_PREFIX}/logout")
async def logout(request: Request, x_token: Optional[str] = Header(None)):
    if x_token:
        await _kv(request).delete(x_token)
    return ok()


# ---------- 客户端开放接口（X-Auth-Key 自主鉴权） ----------
@app.get(f"{API_PREFIX}/project/check")
async def project_check(project_code: str, request: Request,
                        x_auth_key: Optional[str] = Header(None)):
    ip = _ip(request)
    s = await _settings(request)
    if not _hmac_eq(x_auth_key or "", s.get("auth_key") or ""):
        await _check_record(request, project_code, 0, "X-Auth-Key 无效")
        raise HTTPException(401, "X-Auth-Key 无效")
    row = await _db(request).prepare("SELECT * FROM projects WHERE project_code=?").bind(project_code).first()
    if row is None:
        await _check_record(request, project_code, 0, "项目编码未注册")
        return ok({"project_code": project_code, "is_activate": False,
                   "message": "项目编码未注册", "check_time": now_ts()})
    allowed = bool(row.is_activate)
    msg = "校验通过，允许运行" if allowed else "平台已停用，客户端应立即关停服务"
    await _check_record(request, project_code, 1 if allowed else 0, msg)
    return ok({"project_code": project_code, "is_activate": allowed,
               "message": msg, "check_time": now_ts()})


@app.get(f"{API_PREFIX}/info")
async def client_info(request: Request, x_auth_key: Optional[str] = Header(None)):
    s = await _settings(request)
    if not _hmac_eq(x_auth_key or "", s.get("auth_key") or ""):
        raise HTTPException(401, "X-Auth-Key 无效")
    return ok({"service": "activate-center", "time": now_ts()})


# ---------- 管理端（需登录会话） ----------
@app.get(f"{API_PREFIX}/dashboard")
async def dashboard(request: Request):
    await auth_dep(request)
    db = _db(request)
    total = (await db.prepare("SELECT COUNT(*) n FROM projects").first()).n
    active = (await db.prepare("SELECT COUNT(*) n FROM projects WHERE is_activate=1").first()).n
    running = (await db.prepare("SELECT COUNT(*) n FROM projects WHERE status='running'").first()).n
    gcount = (await db.prepare("SELECT COUNT(*) n FROM groups").first()).n
    c24 = (await db.prepare("SELECT COUNT(*) n FROM check_logs WHERE created_at >= datetime('now','-1 day')").first()).n
    c24ok = (await db.prepare("SELECT COUNT(*) n FROM check_logs WHERE result=1 AND created_at >= datetime('now','-1 day')").first()).n
    recent = (await db.prepare("SELECT * FROM check_logs ORDER BY id DESC LIMIT 10").all()).results
    return ok({"total": total, "active": active, "stopped": total - active,
               "running": running, "groups": gcount,
               "check_24h": c24, "check_24h_ok": c24ok,
               "recent": [_row_to_dict(r, ("id", "project_code", "client_ip", "result", "message", "created_at")) for r in recent]})


@app.get(f"{API_PREFIX}/group/list")
async def group_list(request: Request):
    await auth_dep(request)
    r = await _db(request).prepare(
        "SELECT g.*, (SELECT COUNT(*) FROM projects p WHERE p.group_id=g.id) AS project_count FROM groups g ORDER BY g.id").all()
    return ok([_row_to_dict(row, ("id", "name", "remark", "created_at", "project_count")) for row in r.results])


@app.post(f"{API_PREFIX}/group/add")
async def group_add(body: GroupIn, request: Request):
    await auth_dep(request)
    try:
        r = await (_db(request).prepare("INSERT INTO groups(name,remark) VALUES(?,?)")
                   .bind(body.name, body.remark).run())
        gid = r.meta.last_row_id
    except Exception:
        raise HTTPException(400, "分组已存在")
    await _op_record(request, "新建分组", body.name)
    return ok({"id": gid})


@app.put(f"{API_PREFIX}/group/update/{{gid}}")
async def group_update(gid: int, body: GroupIn, request: Request):
    await auth_dep(request)
    r = await _db(request).prepare("UPDATE groups SET name=?, remark=? WHERE id=?").bind(body.name, body.remark, gid).run()
    if r.meta.changes == 0:
        raise HTTPException(404, "分组不存在")
    await _op_record(request, "修改分组", f"#{gid} {body.name}")
    return ok()


@app.delete(f"{API_PREFIX}/group/delete/{{gid}}")
async def group_delete(gid: int, request: Request):
    await auth_dep(request)
    n = (await _db(request).prepare("SELECT COUNT(*) n FROM projects WHERE group_id=?").bind(gid).first()).n
    if n:
        raise HTTPException(400, f"分组下仍有 {n} 个项目，无法删除")
    await _db(request).prepare("DELETE FROM groups WHERE id=?").bind(gid).run()
    await _op_record(request, "删除分组", f"#{gid}")
    return ok()


@app.get(f"{API_PREFIX}/project/list")
async def project_list(request: Request, group_id: Optional[int] = None, q: Optional[str] = None):
    await auth_dep(request)
    sql = ("SELECT p.*, g.name AS group_name FROM projects p "
           "LEFT JOIN groups g ON g.id=p.group_id WHERE 1=1")
    args = []
    if group_id and group_id != 0:
        sql += " AND p.group_id=?"
        args.append(group_id)
    if q:
        sql += " AND (p.name LIKE ? OR p.project_code LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY p.id DESC"
    r = await _db(request).prepare(sql).bind(*args).all()
    return ok([_row_to_dict(row, PROJ_FIELDS, ("is_activate",)) for row in r.results])


@app.post(f"{API_PREFIX}/project/add")
async def project_add(body: ProjectAdd, request: Request):
    await auth_dep(request)
    try:
        r = await (_db(request)
                   .prepare("INSERT INTO projects(project_code,name,group_id,description,is_activate) VALUES(?,?,?,?,?)")
                   .bind(body.project_code, body.name, body.group_id, body.description, 1 if body.is_activate else 0)
                   .run())
        cid = r.meta.last_row_id
    except Exception:
        raise HTTPException(400, "project_code 已存在")
    await _op_record(request, "新建项目", f"{body.name}({body.project_code})")
    return ok({"id": cid})


@app.put(f"{API_PREFIX}/project/status")
async def project_status(body: ProjectStatusIn, request: Request):
    await auth_dep(request)
    val = 1 if body.is_activate else 0
    if body.id is not None:
        where, args = "id=?", [body.id]
    elif body.project_code:
        where, args = "project_code=?", [body.project_code]
    else:
        raise HTTPException(400, "需提供 id 或 project_code")
    row = await _db(request).prepare(f"SELECT * FROM projects WHERE {where}").bind(*args).first()
    if row is None:
        raise HTTPException(404, "项目不存在")
    await _db(request).prepare(f"UPDATE projects SET is_activate=? WHERE {where}").bind(val, *args).run()
    await _op_record(request, "激活" if val else "停用", f"#{row.id} {row.name} -> {bool(val)}")
    return ok({"is_activate": bool(val)})


@app.delete(f"{API_PREFIX}/project/delete/{{pid}}")
async def project_delete(pid: int, request: Request):
    await auth_dep(request)
    await _db(request).prepare("DELETE FROM projects WHERE id=?").bind(pid).run()
    await _op_record(request, "删除项目", f"#{pid}")
    return ok()


@app.post(f"{API_PREFIX}/project/batch")
async def project_batch(body: dict, request: Request):
    await auth_dep(request)
    action, ids = body.get("action"), body.get("ids") or []
    if action not in ("activate", "deactivate") or not ids:
        raise HTTPException(400, "参数错误")
    val = 1 if action == "activate" else 0
    ph = ",".join("?" * len(ids))
    await _db(request).prepare(f"UPDATE projects SET is_activate=? WHERE id IN ({ph})").bind(val, *list(ids)).run()
    await _op_record(request, "批量操作", f"{action} [{' ,'.join(map(str, ids))}]")
    return ok({"updated": len(ids)})


@app.get(f"{API_PREFIX}/log/check")
async def log_check(request: Request, page: int = 1, size: int = 20, project_code: Optional[str] = None):
    await auth_dep(request)
    page = max(page, 1)
    size = min(max(size, 1), 100)
    where, args = "", []
    if project_code:
        where = " WHERE project_code=?"
        args = [project_code]
    total = (await _db(request).prepare(f"SELECT COUNT(*) n FROM check_logs{where}").bind(*args).first()).n
    rows = (await _db(request).prepare(f"SELECT * FROM check_logs{where} ORDER BY id DESC LIMIT ? OFFSET ?")
            .bind(*args, size, (page - 1) * size).all()).results
    return ok({"items": [_row_to_dict(r, ("id", "project_code", "client_ip", "result", "message", "created_at")) for r in rows],
               "total": total, "page": page, "size": size})


@app.get(f"{API_PREFIX}/log/operate")
async def log_operate(request: Request, page: int = 1, size: int = 20):
    await auth_dep(request)
    page = max(page, 1)
    size = min(max(size, 1), 100)
    total = (await _db(request).prepare("SELECT COUNT(*) n FROM op_logs").first()).n
    rows = (await _db(request).prepare("SELECT * FROM op_logs ORDER BY id DESC LIMIT ? OFFSET ?")
            .bind(size, (page - 1) * size).all()).results
    return ok({"items": [_row_to_dict(r, ("id", "operator", "action", "detail", "client_ip", "created_at")) for r in rows],
               "total": total, "page": page, "size": size})


@app.get(f"{API_PREFIX}/settings")
async def get_settings(request: Request):
    await auth_dep(request)
    s = await _settings(request)
    return ok({"admin_user": s.get("admin_user") or "admin", "auth_key": s.get("auth_key")})


@app.put(f"{API_PREFIX}/settings")
async def put_settings(body: SettingsIn, request: Request):
    await auth_dep(request)
    s = await _settings(request)
    if body.new_password:
        if not _hmac_eq(_sha256(body.old_password or ""), s.get("password_hash") or ""):
            raise HTTPException(400, "原密码错误")
        if len(body.new_password) < 6:
            raise HTTPException(400, "新密码至少6位")
        await _set_setting(request, "password_hash", _sha256(body.new_password))
        await _op_record(request, "修改密码", "管理员密码已修改")
    if body.rotate_auth_key:
        ak = "XK-" + secrets.token_hex(16)
        await _set_setting(request, "auth_key", ak)
        await _op_record(request, "轮换密钥", f"新密钥={ak}")
        s = await _settings(request)
    return ok({"auth_key": s.get("auth_key")})


# ---------- 兜底 404 ----------
@app.get("/{path:path}")
async def frontend(path: str, request: Request):
    return JSONResponse(status_code=404, content={"code": 404, "msg": "Not Found", "data": None})


from workers import asgi  # noqa: E402

Default = asgi.entrypoint(app)