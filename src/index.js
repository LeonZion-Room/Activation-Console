/**
 * 激活中心 Activation Console - Cloudflare Worker 后端
 * 迁移自 FastAPI 版（Windows 4600U:8400），保持 /api/v1 接口一致。
 * 存储：D1(SQLite) 数据 + KV(SESSIONS) 登录会话
 */
const J = { "content-type": "application/json;charset=utf-8" };

const ok = (data, msg = "success") => new Response(JSON.stringify({ code: 0, msg, data }), { headers: J });
const bad = (msg, status = 400) => new Response(JSON.stringify({ code: status, msg, data: null }), { status, headers: J });

const sha256 = async (s) => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const hmacEq = (a, b) => a.length === b.length && a.split("").every((ch, i) => ch === b[i]);
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const rndTok = () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return "S-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = {};
  for (const r of results) s[r.key] = r.value;
  return s;
}
async function setSettings(env, key, value) {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value).run();
}

async function opRecord(env, action, detail, ip) {
  await env.DB.prepare("INSERT INTO op_logs(operator,action,detail,client_ip) VALUES('admin',?,?,?)")
    .bind(action, detail, ip).run();
}

async function checkRecord(env, code, ip, result, msg) {
  await env.DB.prepare("INSERT INTO check_logs(project_code,client_ip,result,message) VALUES(?,?,?,?)")
    .bind(code, ip, result, msg).run();
  await env.DB.prepare("UPDATE projects SET last_check_at=datetime('now'), last_status=?, client_ip=?, status=? WHERE project_code=?")
    .bind(result ? "通过" : "拒绝", ip, result ? "running" : "stopped", code).run();
}

/* 管理端会话校验 */
async function adminAuth(env, request) {
  const tok = request.headers.get("x-token") || "";
  const v = await env.SESSIONS.get(tok);
  if (!v) return false;
  return true;
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

/* ---------------- 接口实现 ---------------- */

async function hLogin(env, request) {
  const body = await readJson(request);
  const s = await getSettings(env);
  const h = await sha256((body && body.password) || "");
  if (!hmacEq(h, s.password_hash)) {
    await opRecord(env, "登录失败", "密码错误", request.headers.get("cf-connecting-ip") || "");
    return bad("密码错误", 401);
  }
  const tok = rndTok();
  await env.SESSIONS.put(tok, "1", { expirationTtl: 86400 });
  await opRecord(env, "登录成功", "admin 登录控制台", request.headers.get("cf-connecting-ip") || "");
  return ok({ token: tok, user: s.admin_user || "admin" });
}

async function hDashboard(env) {
  const [total, active, running, gcount, c24, c24ok] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) n FROM projects").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE is_activate=1").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE status='running'").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM groups").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM check_logs WHERE created_at >= datetime('now','-1 day')").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM check_logs WHERE result=1 AND created_at >= datetime('now','-1 day')").first(),
  ]);
  const recent = (await env.DB.prepare("SELECT * FROM check_logs ORDER BY id DESC LIMIT 10").all()).results;
  return ok({
    total: total.n, active: active.n, stopped: total.n - active.n, running: running.n,
    groups: gcount.n, check_24h: c24.n, check_24h_ok: c24ok.n, recent,
  });
}

async function hGroupList(env) {
  const { results } = await env.DB.prepare(
    "SELECT g.*, (SELECT COUNT(*) FROM projects p WHERE p.group_id=g.id) AS project_count FROM groups g ORDER BY g.id").all();
  return ok(results);
}

async function hGroupAdd(env, request) {
  const b = await readJson(request);
  if (!b || !b.name) return bad("分组名称必填");
  try {
    const r = await env.DB.prepare("INSERT INTO groups(name,remark) VALUES(?,?)").bind(b.name, b.remark || "").run();
    await opRecord(env, "新建分组", b.name, request.headers.get("cf-connecting-ip") || "");
    return ok({ id: r.meta.last_row_id });
  } catch (e) { return bad("分组已存在"); }
}

async function hGroupUpdate(env, request, gid) {
  const b = await readJson(request);
  if (!b || !b.name) return bad("分组名称必填");
  const r = await env.DB.prepare("UPDATE groups SET name=?, remark=? WHERE id=?").bind(b.name, b.remark || "", gid).run();
  if (r.meta.changes === 0) return bad("分组不存在", 404);
  await opRecord(env, "修改分组", `#${gid} ${b.name}`, request.headers.get("cf-connecting-ip") || "");
  return ok();
}

async function hGroupDelete(env, request, gid) {
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE group_id=?").bind(gid).first();
  if (n.n > 0) return bad(`分组下仍有 ${n.n} 个项目，无法删除`);
  await env.DB.prepare("DELETE FROM groups WHERE id=?").bind(gid).run();
  await opRecord(env, "删除分组", `#${gid}`, request.headers.get("cf-connecting-ip") || "");
  return ok();
}

async function hProjectList(env, url) {
  const gid = url.searchParams.get("group_id");
  const q = url.searchParams.get("q");
  let sql = "SELECT p.*, g.name AS group_name FROM projects p LEFT JOIN groups g ON g.id=p.group_id WHERE 1=1";
  const args = [];
  if (gid && gid !== "0") { sql += " AND p.group_id=?"; args.push(gid); }
  if (q) { sql += " AND (p.name LIKE ? OR p.project_code LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY p.id DESC";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return ok(results.map((p) => ({ ...p, is_activate: !!p.is_activate })));
}

async function hProjectAdd(env, request) {
  const b = await readJson(request);
  if (!b || !b.project_code || !b.name) return bad("编码与名称必填");
  try {
    const r = await env.DB.prepare(
      "INSERT INTO projects(project_code,name,group_id,description,is_activate) VALUES(?,?,?,?,?)")
      .bind(b.project_code, b.name, b.group_id || 0, b.description || "", b.is_activate ? 1 : 0).run();
    await opRecord(env, "新建项目", `${b.name}(${b.project_code})`, request.headers.get("cf-connecting-ip") || "");
    return ok({ id: r.meta.last_row_id });
  } catch (e) { return bad("project_code 已存在"); }
}

async function hProjectStatus(env, request) {
  const b = await readJson(request);
  if (!b || (b.id == null && !b.project_code) || b.is_activate == null) return bad("参数错误");
  const val = b.is_activate ? 1 : 0;
  const row = b.id != null
    ? await env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(b.id).first()
    : await env.DB.prepare("SELECT * FROM projects WHERE project_code=?").bind(b.project_code).first();
  if (!row) return bad("项目不存在", 404);
  b.id != null
    ? await env.DB.prepare("UPDATE projects SET is_activate=? WHERE id=?").bind(val, b.id).run()
    : await env.DB.prepare("UPDATE projects SET is_activate=? WHERE project_code=?").bind(val, b.project_code).run();
  await opRecord(env, val ? "激活" : "停用", `#${row.id} ${row.name} -> ${!!val}`, request.headers.get("cf-connecting-ip") || "");
  return ok({ is_activate: !!val });
}

async function hProjectDelete(env, request, pid) {
  await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(pid).run();
  await opRecord(env, "删除项目", `#${pid}`, request.headers.get("cf-connecting-ip") || "");
  return ok();
}

async function hProjectBatch(env, request) {
  const b = await readJson(request);
  const ids = (b && b.ids) || [];
  if (!b || !["activate", "deactivate"].includes(b.action) || !ids.length) return bad("参数错误");
  const val = b.action === "activate" ? 1 : 0;
  const ph = ids.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE projects SET is_activate=? WHERE id IN (${ph})`).bind(val, ...ids).run();
  await opRecord(env, "批量操作", `${b.action} [${ids.join(",")}]`, request.headers.get("cf-connecting-ip") || "");
  return ok({ updated: ids.length });
}

async function hCheck(env, request, url) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const code = url.searchParams.get("project_code") || "";
  const key = request.headers.get("x-auth-key") || "";
  const s = await getSettings(env);
  if (!key || !hmacEq(key, s.auth_key)) {
    await checkRecord(env, code, ip, 0, "X-Auth-Key 无效");
    return bad("X-Auth-Key 无效", 401);
  }
  const row = await env.DB.prepare("SELECT * FROM projects WHERE project_code=?").bind(code).first();
  if (!row) {
    await checkRecord(env, code, ip, 0, "项目编码未注册");
    return ok({ project_code: code, is_activate: false, message: "项目编码未注册", check_time: now() });
  }
  const allowed = !!row.is_activate;
  await checkRecord(env, code, ip, allowed ? 1 : 0, allowed ? "校验通过，允许运行" : "平台已停用，客户端应立即关停服务");
  return ok({ project_code: code, is_activate: allowed, message: allowed ? "校验通过，允许运行" : "平台已停用，客户端应立即关停服务", check_time: now() });
}

async function hInfo(env, request) {
  const s = await getSettings(env);
  if (!hmacEq(request.headers.get("x-auth-key") || "", s.auth_key)) return bad("X-Auth-Key 无效", 401);
  return ok({ service: "activate-center", time: now() });
}

async function hLogCheck(env, url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const size = Math.min(Math.max(parseInt(url.searchParams.get("size") || "20", 10), 1), 100);
  const code = url.searchParams.get("project_code");
  let sql = "SELECT * FROM check_logs WHERE 1=1";
  const args = [];
  if (code) { sql += " AND project_code=?"; args.push(code); }
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM check_logs WHERE 1=1` + (code ? " AND project_code=?" : "")).bind(...args).first()).n;
  const { results } = await env.DB.prepare(sql + " ORDER BY id DESC LIMIT ? OFFSET ?").bind(...args, size, (page - 1) * size).all();
  return ok({ items: results, total, page, size });
}

async function hLogOperate(env, url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const size = Math.min(Math.max(parseInt(url.searchParams.get("size") || "20", 10), 1), 100);
  const total = (await env.DB.prepare("SELECT COUNT(*) n FROM op_logs").first()).n;
  const { results } = await env.DB.prepare("SELECT * FROM op_logs ORDER BY id DESC LIMIT ? OFFSET ?")
    .bind(size, (page - 1) * size).all();
  return ok({ items: results, total, page, size });
}

async function hGetSettings(env) {
  const s = await getSettings(env);
  return ok({ admin_user: s.admin_user || "admin", auth_key: s.auth_key });
}

async function hPutSettings(env, request) {
  const b = await readJson(request);
  const s = await getSettings(env);
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (b && b.new_password) {
    const old = await sha256((b.old_password || ""));
    if (!hmacEq(old, s.password_hash)) return bad("原密码错误");
    if (b.new_password.length < 6) return bad("新密码至少6位");
    await setSettings(env, "password_hash", await sha256(b.new_password));
    await opRecord(env, "修改密码", "管理员密码已修改", ip);
  }
  if (b && b.rotate_auth_key) {
    const ak = "XK-" + rndTok().slice(2);
    await setSettings(env, "auth_key", ak);
    await opRecord(env, "轮换密钥", "已轮换", ip);
  }
  return ok({ auth_key: b && b.rotate_auth_key ? (await env.DB.prepare("SELECT value FROM settings WHERE key='auth_key'").first()).value : s.auth_key });
}

/* ---------------- 路由 ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    try {
      if (m === "GET" && p === "/health") return ok({ status: "ok", service: "activate-center", time: now() });

      if (m === "POST" && p === "/api/v1/login") return await hLogin(env, request);
      if (m === "POST" && p === "/api/v1/logout") { await env.SESSIONS.delete(request.headers.get("x-token") || ""); return ok(); }

      /* 以下均需管理会话 */
      if (!(await adminAuth(env, request))) return bad("未登录或会话已过期", 401);

      if (m === "GET" && p === "/api/v1/dashboard") return await hDashboard(env);
      if (m === "GET" && p === "/api/v1/group/list") return await hGroupList(env);
      if (m === "POST" && p === "/api/v1/group/add") return await hGroupAdd(env, request);
      let mt;
      if ((mt = p.match(/^\/api\/v1\/group\/update\/(\d+)$/)) && m === "PUT") return await hGroupUpdate(env, request, mt[1]);
      if ((mt = p.match(/^\/api\/v1\/group\/delete\/(\d+)$/)) && m === "DELETE") return await hGroupDelete(env, request, mt[1]);

      if (m === "GET" && p === "/api/v1/project/list") return await hProjectList(env, url);
      if (m === "POST" && p === "/api/v1/project/add") return await hProjectAdd(env, request);
      if (m === "PUT" && p === "/api/v1/project/status") return await hProjectStatus(env, request);
      if ((mt = p.match(/^\/api\/v1\/project\/delete\/(\d+)$/)) && m === "DELETE") return await hProjectDelete(env, request, mt[1]);
      if (m === "POST" && p === "/api/v1/project/batch") return await hProjectBatch(env, request);

      if (m === "GET" && p === "/api/v1/log/check") return await hLogCheck(env, url);
      if (m === "GET" && p === "/api/v1/log/operate") return await hLogOperate(env, url);

      if (m === "GET" && p === "/api/v1/settings") return await hGetSettings(env);
      if (m === "PUT" && p === "/api/v1/settings") return await hPutSettings(env, request);

      /* 客户端开放接口 */
      if (m === "GET" && p === "/api/v1/project/check") return await hCheck(env, request, url);
      if (m === "GET" && p === "/api/v1/info") return await hInfo(env, request);

      return bad("Not Found", 404);
    } catch (e) {
      return bad("Internal: " + (e && e.message), 500);
    }
  },
};