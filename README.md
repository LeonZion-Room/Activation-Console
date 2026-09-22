# 激活中心 Activation Console（Cloudflare 公网版）

> 自动化运维激活管控控制台：每日心跳校验控制服务保活/强制关停。
> 仓库源：GitHub LeonZion-Room/Activation-Console → Cloudflare 无服务器部署。
>
> - **正式入口**：`https://activation.szdptk.com/`（自定义域名，2026-09-23 起由 Python FastAPI Worker 承载）
> - 测试金丝雀：`https://actpy.szdptk.com/`（同一 Python Worker）
> - 底层地址：`https://activation-console-py-fastapi.leonzion7.workers.dev`（本网络 `.workers.dev` 被拦，故绑自定义域名）
> - 内网 FastAPI 版：4600U（172.168.13.103:8400）

## 架构（双实现，接口 `/api/v1` 全一致）

| 目录 | 技术 | 状态 |
|------|------|------|
| `src/`（仓库根） | JS Worker（零依赖） | 已上线，作回滚备份 |
| `python-fastapi/` | **Cloudflare Python Workers（FastAPI @ ASGI）** | 当前生产（正式域名） |

- **数据库**：Cloudflare D1（SQLite，`migrations/0001_init.sql`），两实现共用同一库
- **会话**：Cloudflare KV（`SESSIONS`，24h TTL）
- **前端**：静态资产；JS 版 `assets/`，Python 版 `python-fastapi/public/`（`run_worker_first=false` 直出）

## 默认账号

- 管理密码：`wswwsw1234`
- 客户端全局密钥 `X-Auth-Key`：见 `migrations/0001_init.sql`（登录后可在设置页轮换）

## Python FastAPI 版部署（重点，2026-09-23 验证）

```bash
# 依赖：uv + Node>=22 + npm/npx（此机已验证 v22.23.2）
export CLOUDFLARE_API_KEY='cfk_...' CLOUDFLARE_EMAIL='leonzion7@outlook.com' CLOUDFLARE_ACCOUNT_ID='...'

cd python-fastapi
uv sync                # 首次：安装 fastapi 至 python_modules，pywrangler 1.17+
uv run pywrangler deploy   # -> activation-console-py-fastapi.<sub>.workers.dev
```

要点：
- `wrangler.toml`：`compatibility_flags=["python_workers"]`，入口 `src/worker.py`（`workers.asgi.entrypoint(app)`）
- pywrangler 会把 FastAPI(0.125)+starlette+pydantic 打进化 pyodide/WASM 包（上传约 8.6MB）
- 静态资源走 `run_worker_first=false`，无须在 Python 内 `env.ASSETS.fetch()`（该调用在 Python 端会 500）
- 路径参数装饰器须用 `{{gid}}` 转义（`@app.put(f"{API_PREFIX}/group/update/{{gid}}")`），否则导入期 NameError
- **自定义域名切换**：改 zone `workers/routes` 的 `activation.szdptk.com/*` → `script` 指向 `activation-console-py-fastapi`
  （回滚：把 script 指回 js Worker 名 `activation-console` 即可）

## JS Worker 版部署（回滚/参考）

```bash
npx --yes wrangler@3.107.3 d1 create activation-console      # 回填 wrangler.toml database_id
npx --yes wrangler@3.107.3 kv namespace create SESSIONS       # 回填 kv id
npx --yes wrangler@3.107.3 d1 migrations apply activation-console
npx --yes wrangler@3.107.3 deploy                             # -> https://activation-console.<sub>.workers.dev
```

## 心跳校验（客户端）

```bash
curl "https://activation.szdptk.com/api/v1/project/check?project_code=svc-backup" \
  -H "X-Auth-Key: <全局密钥>"
```

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/v1/login | 登录（X-Token） |
| GET | /api/v1/dashboard | 看板 |
| GET/POST | /api/v1/group/list \| add | 分组 |
| PUT/DELETE | /api/v1/group/update\|delete/{id} | 分组改删 |
| GET/POST | /api/v1/project/list \| add | 项目 |
| PUT | /api/v1/project/status | 激活⇄停用 |
| DELETE | /api/v1/project/delete/{id} | 删除 |
| POST | /api/v1/project/batch | 批量 |
| GET | /api/v1/project/check | **心跳校验（X-Auth-Key）** |
| GET | /api/v1/info | 服务信息（X-Auth-Key） |
| GET | /api/v1/log/check \| operate | 日志 |
| GET/PUT | /api/v1/settings | 设置 |