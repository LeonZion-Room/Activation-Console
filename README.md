# 激活中心 Activation Console（Cloudflare Worker 版）

> 自动化运维激活管控控制台：每日心跳校验控制服务保活/强制关停。
> 仓库源：GitHub LeonZion-Room/Activation-Console → Cloudflare Worker 无服务器部署。
> 由 FastAPI 版改写，保持 `/api/v1` 接口一致；内网 FastAPI 版部署于 4600U（172.168.13.103:8400），本仓库为公网云端版。

## 架构

- **后端**：Cloudflare Worker（`src/index.js`，零依赖 JS）
- **数据库**：Cloudflare D1（SQLite 兼容，`migrations/0001_init.sql`）
- **会话**：Cloudflare KV（`SESSIONS`，24h TTL）
- **前端**：静态资产 `assets/`（`assets` binding 自动直出）

## 默认账号

- 管理密码：`wswwsw1234`
- 客户端全局密钥 `X-Auth-Key`：见 `migrations/0001_init.sql`（登录后可在设置页轮换）

## 部署（wrangler@3，node18 已验证）

```bash
export CLOUDFLARE_API_KEY='cfk_...' CLOUDFLARE_EMAIL='leonzion7@outlook.com' CLOUDFLARE_ACCOUNT_ID='...'

npx --yes wrangler@3.107.3 d1 create activation-console      # 回填 wrangler.toml database_id
npx --yes wrangler@3.107.3 kv namespace create SESSIONS       # 回填 kv id
npx --yes wrangler@3.107.3 d1 migrations apply activation-console
npx --yes wrangler@3.107.3 deploy                             # -> https://activation-console.<sub>.workers.dev
```

## 心跳校验（客户端）

```bash
curl "https://<workers.dev域名>/api/v1/project/check?project_code=svc-backup" \
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