# NyxID Assistant Chat

这是准备直接集成到 NyxID website 的 Assistant 页面。它复用用户已经建立的 NyxID
站点登录态，不再注册或授权 `aevatar` developer app，也不再创建 developer-app OAuth
session、broker `binding_id` 或执行 token exchange。

NyxID 当前网页端并不会把 access token 暴露给 JavaScript。浏览器使用的是 HttpOnly
`nyx_session` cookie；同源部署时浏览器会自动把它带给 Chat BFF。BFF 调用
`/api/v1/users/me` 校验用户，再把同一登录凭据转发给 NyxID proxy。proxy 校验凭据后，为每次
Aevatar 请求注入短期 `X-NyxID-Identity-Token` 和 `X-NyxID-Delegation-Token`；BFF 和浏览器
都不读取、签发或转发这两个代理专用 token。宿主若使用 token-based 认证，也可以显式传入
`Authorization: Bearer ...`，但标准 website 集成不需要读取或存储 access token。

localhost 联调是一个受限的例外：由于线上 HttpOnly cookie 不可能发送给 localhost，登录入口
会使用 NyxID 已有的 `/cli-auth` first-party handoff。它基于用户现有站点 session 签发普通用户
token，回送到本机 `/callback`；BFF 把 access/refresh token 保存在内存中，浏览器只得到一枚
本机 HttpOnly session cookie。该流程同样不需要 developer app。

## 请求链路

```text
NyxID website (already signed in)
  -> Chat BFF + nyx_session
     -> NyxID /api/v1/users/me
     -> NyxID proxy /aevatar + the same site session
        -> X-NyxID-Identity-Token (caller identity, aud urn:aevatar:api)
        -> X-NyxID-Delegation-Token (downstream NyxID access)
        -> Aevatar / NyxIdChatGAgent
           -> the user's configured NyxID services
```

```text
localhost development
  -> NyxID /cli-auth + existing nyx_session
     -> localhost /callback + user tokens
        -> local HttpOnly BFF session
           -> NyxID proxy
```

这里仍有三个独立的安全边界：

- NyxID 站点 session 证明当前用户身份。
- `/api/v1/user-services` 和 NyxID proxy policy 决定该用户可以使用哪些 service。
- 写入或不可逆操作仍必须由 NyxID/Aevatar 服务端 policy 强制批准。

不存在 developer-app consent 或 RFC 8707 resource allowlist。Services 面板展示的是当前
账户的连接可用性；缺少连接时打开 NyxID 的 `/keys` 页面进行配置。Agent 返回
`AUTHORIZATION_REQUIRED` 时，Chat 仍会保留原请求并显示配置卡，但只有用户明确点击
“重试请求”才会再次提交，避免重复已经部分执行的生产操作。

## 部署要求

生产环境必须把页面和 BFF 放在 NyxID website 的同一站点下，或由同一入口反向代理，确保：

- 浏览器请求 Chat API 时会自动携带 `nyx_session`。
- session cookie 的 `Path` 覆盖 Chat API；默认 cookie 名是 `nyx_session`。
- 反向代理保留原始 `Host`，或设置可信的 `X-Forwarded-Host` / `X-Forwarded-Proto`。
- NyxID API 仍由 `NYXID_BASE_URL` 指向；BFF 不直接读取 NyxID 数据库。

不要为了跨域 standalone 页面把 HttpOnly session token 写入 localStorage。生产页面若运行在
另一个 site，仍无法安全复用 NyxID 的站点 cookie；内置 token handoff 只接受
`localhost`、`127.0.0.1` 和 loopback IPv6。

## 配置

```dotenv
HOST=127.0.0.1
PORT=4310
NYXID_BASE_URL=https://nyx-api.chrono-ai.fun
NYXID_WEB_URL=https://nyx.chrono-ai.fun
NYXID_SESSION_COOKIE_NAME=nyx_session
NYXID_AEVATAR_PROXY_URL=https://nyx-api.chrono-ai.fun/api/v1/proxy/s/aevatar
NYXID_LLM_SERVICE_SLUG=chrono-llm-public
NYXID_ORNN_SERVICE_SLUG=ornn-api
DEMO_STREAM_PROGRESS_TIMEOUT_MS=120000
```

不再需要以下变量：

```text
NYXID_OAUTH_CLIENT_ID
NYXID_OAUTH_REDIRECT_URI
NYXID_OAUTH_SCOPES
```

完整配置见 `.env.example`。`server.mjs` 不自行加载 `.env`；`boot.sh` 会加载它并传给后台
进程，其他启动方式需由 shell、容器或进程管理器注入。

NyxID 中 `aevatar` service 的身份传播配置必须是：

```json
{
  "identity_propagation_mode": "jwt",
  "identity_jwt_audience": "urn:aevatar:api",
  "inject_delegation_token": true,
  "forward_access_token": false
}
```

这是 NyxID service catalog 配置，不是本仓库的环境变量。`inject_delegation_token` 不能关闭，
因为 Aevatar 在确认调用者身份后仍需要代表用户调用 NyxID API、LLM route 和 tools。

## 运行

要求 Node.js 20+：

```bash
npm install
npm start
```

也可以使用根目录脚本；它会加载 `.env`、停止本 repo 的旧进程，并在 macOS 上交给
`launchd` 托管：

```bash
./boot.sh
```

直接打开 `http://127.0.0.1:4310` 后点击登录，会先进入 NyxID `/cli-auth`；已有登录态时会
自动回到本机，未登录时则先完成 NyxID 登录再回跳。生产部署仍应使用同源站点 session，
不会经过该 handoff。

SSE 连续 120 秒只收到 keepalive 而没有工具、文本或运行状态事件时，BFF 会返回
`UPSTREAM_PROGRESS_TIMEOUT` 并取消上游流。可通过 `DEMO_STREAM_PROGRESS_TIMEOUT_MS` 调整。

## 本地 API

```text
GET    /api/auth/login          # 同源跳登录页；localhost 跳 first-party token handoff
GET    /callback                # localhost token handoff callback
GET    /api/auth/session        # 校验并返回当前站点用户，不返回凭据
GET    /api/auth/services       # 当前用户的 service 可用性
POST   /api/auth/logout         # 退出整个 NyxID 站点 session

GET    /api/nyxid/connectors      # 合并 NyxID /api/v1/keys（已连接）与 /api/v1/catalog（可连接）
POST   /api/nyxid/keys            # 代理 NyxID POST /api/v1/keys，聊天内直连 api-key 类服务

GET    /api/demo/config
POST   /api/demo/health
POST   /api/demo/chat
POST   /api/demo/approve
GET    /api/demo/conversations
GET    /api/demo/conversations/{actorId}
DELETE /api/demo/conversations/{actorId}
```

## 聊天内连接卡片（connect card）

对齐 NyxID assistant 的 block 模型（`connect_card`，见 NyxID `frontend/src/types/assistant.ts`）
与 `design/nyxid-assistant-shell.html` 设计稿：

- `POST /api/demo/chat` 转发前，BFF 会用当前用户会话拉取 `/api/v1/keys` + `/api/v1/catalog`
  （60 秒缓存），把“已连接 / 可连接”服务目录以 `[[NYXID_CONTEXT]]…[[/NYXID_CONTEXT]]` 块
  附加在用户 prompt 之后（用户文本在前，保证会话标题干净）。
- 上下文教会 LLM：任务需要未连接服务时，输出 ```` ```nyxid:connect ```` 代码块
  （`{"catalog_slug":"…","reason":"…"}`）。前端把该 fence 渲染成设计稿里的富连接卡片：
  品牌抬头 + 状态 pill + 三步向导 + 操作按钮。
- api-key 类服务可在卡片内直接粘贴 key（经 `POST /api/nyxid/keys` 提交给 NyxID，
  不落聊天记录）；OAuth / device-code 类跳转 NyxID `/keys?slug=…` 深链，回来后
  “刷新状态”。连接成功后卡片翻绿并自动重试原始请求。
- Aevatar 返回 `AUTHORIZATION_REQUIRED` 时，若缺失服务能在目录中解析出来，同样渲染
  富连接卡片（否则退回原有的 authorization callout）。
- 读取历史时，BFF 会从用户消息中剥离注入的上下文块；assistant 消息里的 fence 在
  重新加载会话时照常渲染成卡片。

旧的 `GET /api/auth/authorize` 会返回 `410 DEVELOPER_APP_AUTH_REMOVED`，用于尽早发现仍在调用
developer-app consent 的旧前端；OAuth callback 已删除。

## 安全边界

- BFF 只从浏览器 cookie 中挑选 `NYXID_SESSION_COOKIE_NAME`，不会把其他站点 cookie 转发给
  NyxID API 或 Aevatar。
- localhost handoff 使用一次性随机 state（10 分钟有效）；token 只进入 BFF 内存，refresh
  token 不写入浏览器 storage。
- 同源登录由页面显式携带当前站内回跳路径，BFF 只接受 NyxID website 同源目标。
- 显式 bearer 优先于 ambient cookie，方便由可信宿主注入 token；响应和日志不回显凭据。
- 浏览器提交的 `X-NyxID-Identity-Token` 和 `X-NyxID-Delegation-Token` 不会被 BFF 转发；
  只有 NyxID proxy 可以在发往 Aevatar 的请求上注入它们。
- 所有非安全方法继续执行同源校验，支持反向代理的 `X-Forwarded-Host`。
- 用户 ID 只取自 `/api/v1/users/me`，忽略浏览器提交的 scope 或 user ID；`POST /api/chat`
  不发送 body `scopeId`，由 Aevatar 只按已验证 identity token 的 `sub` 派生 scope。
- 仍包含 `scopeId` 的 Aevatar 路径只使用服务端验证出的用户 ID；Aevatar 会再次校验它与
  identity token 的 `sub` 一致，不一致时返回 HTTP 403。
- logout 的 `Set-Cookie` 会从 NyxID API 原样返回浏览器。
- SSE/raw event 继续执行凭据和 reasoning 脱敏。
- Aevatar approval 卡片不是最终安全边界，proxy policy 必须独立执行。

## 验证

```bash
npm test
node --check server.mjs
node --check public/app.js
node --check public/protocol.js
```

测试覆盖站点 cookie/bearer 转发、cookie 与代理专用 header allowlist、scope override 防护、
同源保护、登录与退出、service 配置后显式重试、多会话并行、SSE normalization、usage 合并、
历史 normalization 和凭据脱敏。

## 文件结构

```text
server.mjs                         # first-party session BFF + NyxID/Aevatar SSE proxy + 服务目录注入
public/index.html                  # Chat、账户和 service 可用性 UI
public/styles.css                  # 响应式界面（含 connect-card 设计稿样式）
public/app.js                      # 站点 session、会话、service 配置、SSE、审批和连接卡片
public/protocol.js                 # SSE/AGUI/protobuf normalization + redaction
public/blocks.js                   # nyxid:connect fence 解析 + NyxID block 模型
test/server.test.mjs               # first-party session BFF 集成测试
test/server-connectors.test.mjs    # 服务目录合并、key 创建、上下文注入与历史剥离测试
test/app-authorization.test.mjs    # service 配置与显式重试测试
test/app-connect-card.test.mjs     # LLM fence → 连接卡片 → 自动重试端到端测试
test/app-concurrency.test.mjs      # 多会话并行 SSE 与视图隔离测试
test/protocol.test.mjs             # 协议测试
test/blocks.test.mjs               # fence 解析与 block 构建测试
```
