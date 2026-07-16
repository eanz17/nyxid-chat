# NyxID x Aevatar Chat

这是 NyxID Assistant 的生产联调页面。浏览器通过 NyxID OIDC 授权 `aevatar`
developer app，并默认请求 Aevatar、Chrono LLM 和 Ornn 三个核心 service。用户确认后，
本地 BFF 保存 HttpOnly session 和服务器侧 broker `binding_id`，再用短期 access token
经 NyxID proxy 调用生产 Aevatar。

浏览器不接触 NyxID access token、refresh token、broker binding 或 service credential。

## 生产端点

| 系统 | 端点 | 用途 |
|---|---|---|
| NyxID | `https://nyx-api.chrono-ai.fun` | OIDC、service consent、broker 和 proxy |
| Aevatar via NyxID | `https://nyx-api.chrono-ai.fun/api/v1/proxy/s/aevatar` | Chat 的固定入口 |
| Chrono LLM | NyxID service slug `chrono-llm-public` | Chat 的默认 LLM |
| Aevatar | `https://aevatar-console-backend-api.aevatar.ai` | `NyxIdChatGAgent` |
| Ornn | NyxID service slug `ornn-api` | 默认 skill search / execution |

## OAuth 配置

联调前需要创建或选择一个启用了 broker capability 的 NyxID public developer app：

- Client ID：通过 `NYXID_OAUTH_CLIENT_ID` 环境变量提供，不提交到仓库
- 本地 callback：`http://127.0.0.1:4310/auth/callback`
- 备用开发 callback：`http://127.0.0.1:4311/auth/callback`
- 请求 scopes：`openid profile email proxy`
- 不请求 `offline_access`；持续访问使用 opaque broker binding
- 初次授权请求 `aevatar`、`chrono-llm-public` 和 `ornn-api` resources

生产部署应改为正式 Chat client，并使用 confidential client 或 DPoP/mTLS sender
constraint。

## 运行

要求 Node.js 20+，不要求 NyxID CLI 登录态。

```bash
NYXID_OAUTH_CLIENT_ID=your-public-client-id npm start
```

打开 <http://127.0.0.1:4310>，点击“使用 NyxID 登录”。

如端口或域名不同，callback 必须精确注册，并通过环境变量覆盖：

```bash
PORT=4311 \
NYXID_OAUTH_REDIRECT_URI=http://127.0.0.1:4311/auth/callback \
npm start
```

完整配置见 `.env.example`。服务不会自动加载 `.env`，需由 shell、容器或进程管理器注入。

## 授权模型

```text
Browser
  -> local BFF HttpOnly session
     -> NyxID Authorization Code + PKCE
        -> consent: aevatar + chrono-llm-public + ornn-api + selected resources
           -> opaque broker binding (server-side only)
              -> 5-minute access token
                 -> NyxID proxy / aevatar
                    -> NyxIdChatGAgent
                       -> authorized NyxID services only
```

登录、service consent 和单次高风险操作批准是三个不同边界：

- 登录证明 NyxID 用户身份，并默认请求三个 Chat 核心 services；用户仍需在 NyxID 明确确认。
- Service access 由 consent 的 RFC 8707 resource allowlist 决定。
- 写入或不可逆操作仍必须由 NyxID/Aevatar 服务端 policy 强制批准。

## 增量 Service 授权

NyxID 当前支持从 Chat 发起增量授权：

1. BFF 用当前 access token读取 `/api/v1/user-services`。
2. 用户在 Chat 的 Services 面板点击“授权”。
3. BFF 读取该 client 当前 consent，并携带原有 resources 与新增 resource 重新 authorize。
4. NyxID 显示 consent 页面；用户确认后返回新的 authorization code 和 broker binding。
5. BFF 原子替换 session binding，并撤销旧 binding。

入口是 `GET /api/auth/authorize?serviceId=<USER_SERVICE_ID>`。service ID 会在 BFF 中解析为
NyxID 返回的 canonical `resource_uri`，浏览器不能自行提交任意上游 URL。由于 NyxID consent
更新会替换 allowlist，BFF 会显式合并已有 consent，避免复用 `aevatar` client 时误删权限。

对于升级前已经登录、但缺少 Chrono LLM 或 Ornn 权限的 session，页面会检测缺失的核心
service 并自动发起一次补充 consent。若用户拒绝，本标签页不会循环跳转；用户仍可稍后在
Services 面板手动再次授权。

当前 NyxID broker binding exchange 只窄化 OAuth scope，不接受单次 exchange 的 resource
窄化。因此本实现的最小权限边界是“当前 consent/binding 已授权的 services”，不是“单次
tool call 的一个 service”。后续应让 binding exchange 接受 `resource` 并与 consent 求交集。

## 多会话并行

Chat 前端按 conversation 保存独立的 actor/session、SSE controller、消息视图、审批状态、
工具步骤、events 和 usage。新建或切换会话不会终止其他会话的流；后台会话继续完整消费
事件，切回时直接恢复原视图。停止按钮只停止当前会话，退出登录和删除会话才会终止相应
controller。

## 本地 API

```text
GET    /api/auth/login
GET    /auth/callback
GET    /api/auth/session
GET    /api/auth/services
GET    /api/auth/authorize?serviceId=...
POST   /api/auth/logout

GET    /api/demo/config
POST   /api/demo/health
POST   /api/demo/chat
POST   /api/demo/approve
GET    /api/demo/conversations
GET    /api/demo/conversations/{actorId}
DELETE /api/demo/conversations/{actorId}
```

所有 `/api/demo/*` 运行和历史接口都从 HttpOnly session 解析用户 `sub` 作为 Aevatar
scope，忽略浏览器提交的 scope 或 bearer。

## 安全边界

- OAuth 使用 Authorization Code、PKCE S256、state 和 nonce。
- ID token 使用 NyxID JWKS 验证 RS256、issuer、audience、expiry 和 nonce。
- broker binding 和短期 access token 只保存在 BFF 内存。
- 增量授权只能选择 `/api/v1/user-services` 返回且当前可用的 service。
- logout 和 binding 替换都会撤销旧 binding。
- SSE/raw event 仍执行凭据与 reasoning 脱敏。
- Aevatar approval 卡片不是最终安全边界；proxy policy 必须独立执行。

本地内存 session 适合联调，不适合多实例生产。正式部署需要加密的共享 session store、
DPoP 或 mTLS、完整的 binding 生命周期清理，以及 revocation webhook。

## Aevatar API surface

```text
POST   /api/chat
POST   /api/scopes/{scopeId}/nyxid-chat/conversations
GET    /api/scopes/{scopeId}/nyxid-chat/conversations
DELETE /api/scopes/{scopeId}/nyxid-chat/conversations/{actorId}
POST   /api/scopes/{scopeId}/nyxid-chat/conversations/{actorId}:stream
POST   /api/scopes/{scopeId}/nyxid-chat/conversations/{actorId}:approve
GET    /api/scopes/{scopeId}/chat-history
GET    /api/scopes/{scopeId}/chat-history/conversations/{actorId}
DELETE /api/scopes/{scopeId}/chat-history/conversations/{actorId}
```

## 验证

```bash
npm test
node --check server.mjs
node --check public/app.js
node --check public/protocol.js
```

协议测试覆盖 SSE 分块、Aevatar frame normalization、结构化 service authorization request、
usage 合并、历史 normalization 以及凭据/reasoning 脱敏。

## 文件结构

```text
server.mjs              # OAuth BFF、broker session、NyxID/Aevatar SSE proxy
public/index.html       # Chat、账户和 service access UI
public/styles.css       # 响应式界面
public/app.js           # OAuth 状态、会话、增量授权、SSE 和审批
public/protocol.js      # SSE/AGUI/protobuf normalization + redaction
test/protocol.test.mjs  # 协议测试
test/server.test.mjs    # OAuth BFF 与增量授权集成测试
test/app-concurrency.test.mjs # 多会话并行 SSE 与视图隔离测试
```
