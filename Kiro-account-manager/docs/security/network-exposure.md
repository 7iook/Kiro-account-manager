# TLS 前置、监听地址、转发头与防火墙

## 必做前提：显式声明受信代理

TLS 前置部署必须设置 `KIRO_TRUSTED_TLS_PROXY_IPS`。配置层负责解析和拒绝非法地址（`src/main/server/config.ts:67-85,143-183`），生产装配把该环境值作为只读覆盖同时注入面板与数据反代，并剥离任何盘上同名值（`src/main/server/assembly.ts:380-431,519-580`）。

**不设置时，前置代理发送的转发头不会参与任何安全判定。** 应用层 `allowedIPs` / `deniedIPs` 只会看到代理 peer（同机时通常是 `127.0.0.1`），面板 cookie 也不会因外层 HTTPS 自动获得 `Secure`。如果读者只记住一件事，就是：**“TLS 已由 Caddy 终止”不等于“应用知道真实客户端或 TLS 上下文”；必须显式 opt-in 并验收。**

## 安全边界

本服务**不终止 TLS**。Node 面板和反代都是 HTTP；TLS 必须由前置代理承担（`src/main/server/entry.ts:47-50`）。因此：

- adminKey 经公网明文 HTTP 发送，等价于公开 adminKey；
- 会话 cookie 经公网明文 HTTP 发送，可被劫持；
- 不存在“先临时公网 HTTP 跑起来再补证书”的安全窗口。

初始默认均为 loopback：面板 `127.0.0.1:5590`、数据反代 `127.0.0.1:5580`（`src/main/server/assembly.ts:275-304`）。面板可用 `KIRO_PANEL_HOST`/`KIRO_PANEL_PORT` 只读覆盖；生产中的同机前置代理应保留 loopback（`src/main/server/config.ts:67-85,143-167`；`src/main/server/assembly.ts:519-537`）。反代 host/port 来自 `kiro-accounts.json` 的 `proxyConfig`，没有环境变量覆盖；迁移后必须核对目标副本（`src/main/server/assembly.ts:555-580`）。

## Canonical：Caddy

本文选 Caddy 作为唯一标准示例，原因是它默认自动申请/续期公开证书、默认启用安全 TLS 参数，配置较短，减少“服务已经公网开放但证书续期脚本还没装”的危险窗口。nginx 同样可用，但证书申请/续期、流式缓冲和下述路径拒绝规则必须由运维显式完成。

前提：

- `panel.example.com` 与 `api.example.com` 的 DNS 已指向服务器；
- TCP 80/443 可从公网到 Caddy；
- 5590/5580 只允许本机；
- 服务配置中的面板与反代 host 均为 `127.0.0.1`；
- `/etc/kiro-account-manager/server.env` 设置 `KIRO_TRUSTED_TLS_PROXY_IPS=127.0.0.1`；若 Caddy 到后端实际走 IPv6，按后端 socket 真正看到的 peer 改为 `::1`，不要猜测或宽泛填写 `127.0.0.0/8`；
- adminKey 已按 `docs/operations/key-handling.md` 建立。

`KIRO_TRUSTED_TLS_PROXY_IPS` 填的是**后端 socket 看到的 TLS 终止代理源地址**，不是允许访问的客户端网段。未设置它时，应用会忽略所有转发头；此时若把真实客户端地址写进 `allowedIPs` / `deniedIPs`，规则不会匹配。把 `127.0.0.1` 写进 allowlist 来“修好”访问则会放行该代理转来的所有客户端，不能实现按客户端限制（`src/main/utils/netGuard.ts:92-137`；面板判定 `src/main/webPanel/server.ts:266-295`；数据反代判定 `src/main/proxy/proxyServer.ts:2384-2435`）。

`/etc/caddy/Caddyfile`：

```caddyfile
panel.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:5590 {
		# 应用不读取 RFC Forwarded；删除客户端自带值，避免下游误用。
		header_up -Forwarded
	}
}

api.example.com {
	@private path / /health /metrics /admin /admin/*
	respond @private 404

	reverse_proxy 127.0.0.1:5580 {
		header_up -Forwarded

		# OpenAI/Anthropic/Gemini 流式响应应立即转发，不在前置层积攒。
		flush_interval -1
	}
}
```

本示例假设客户端直接连接 Caddy。Caddy `reverse_proxy` 默认自行设置 `X-Forwarded-For/Proto/Host`，并在请求来源未被配置成 Caddy 自己的 `trusted_proxies` 时忽略客户端传入值；不要再把任意公网来源加入 Caddy 的 trusted proxy 列表。若 Caddy 前面还有 CDN/LB，必须按 [Caddy 官方 `reverse_proxy` 合同](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults) 配置那一层的受信范围并保留净化后的完整链，同时在 `KIRO_TRUSTED_TLS_PROXY_IPS` 中声明右向左剥链所需的每个受控代理 hop；仍不得填写客户端网段。

检查后再加载：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl restart kiro-account-manager
sudo journalctl -u caddy -b --no-pager
curl --silent --show-error --output /tmp/ready.json \
  --write-out '%{http_code}\n' https://panel.example.com/panel/readyz
cat /tmp/ready.json
curl -i https://api.example.com/health
```

API `/health` 预期为 404；不能是带账号/统计的 200。readiness 为 200 或 503 都证明请求经 HTTPS front 到达面板；400 表示受信代理没有提供合法 `X-Forwarded-For`，必须先修转发元数据。随后：

1. 通过浏览器登录，确认 `kam_panel_sid` 的 `Set-Cookie` 带 `Secure`；该属性只在请求经已校验的受信 TLS proxy 时加入（`src/main/webPanel/auth.ts:158-190`；`src/main/webPanel/cookie.ts:34-62`）。
2. 从一个允许来源和一个应拒绝来源分别访问，证明 `allowedIPs` / `deniedIPs` 按真实客户端地址生效；只看到“都能访问”或“都不能访问”不算通过。
3. 做一次受控流式代理请求，确认前置层未缓冲。

不要用 `curl http://127.0.0.1:5590/...` 作为启用受信 loopback peer 后的成功条件：直连请求缺少 `X-Forwarded-For`，应被请求边界以 400 拒绝。

### nginx 用户必须改什么

不要再写第二份半成品示例。将同一合同翻译为 nginx 时，必须逐项实现：

1. 两个 TLS `server_name`，证书自动续期且续期失败有告警；
2. 两个 upstream 仍是 `127.0.0.1:5590/5580`；
3. API vhost 对 `/`、`/health`、`/metrics`、`/admin/` 在前置层返回 404/403；
4. 数据面关闭 `proxy_buffering`，并设置足够长的流式读超时；
5. 保留原始 Host；删除客户端自带的 `Forwarded` / `X-Forwarded-*` 后由 nginx 写入自己的 `X-Forwarded-For`，不得把客户端原值原样透传；
6. reload 前跑 `nginx -t`，并执行与上面相同的外部验证。

## Forwarded headers：何时才可信

受信模式是显式 opt-in，不会根据 loopback 自动猜测。`resolveClientIP()` 的合同是（`src/main/utils/netGuard.ts:92-137`）：

1. 先归一化 socket peer；peer 不命中 `KIRO_TRUSTED_TLS_PROXY_IPS` 时完全忽略 `X-Forwarded-For`。
2. peer 命中后才读取转发链；缺失、非法地址或超过 32 hop 时 fail closed，返回 400，不退回代理地址继续放行。
3. 从右向左剥离受信 hop，在第一个不受信地址停止；不采用可由客户端预置的“最左值”。
4. 解析出的地址同时用于面板登录限流、面板 IP policy 和数据反代 IP policy（`src/main/webPanel/server.ts:266-295`；`src/main/proxy/proxyServer.ts:2251-2263,2384-2435`）。

应用**不读取 `X-Forwarded-Proto`**。`KIRO_TRUSTED_TLS_PROXY_IPS` 这一声明本身同时断言“该 peer 是 TLS 终止代理”，从而令面板登录、登出和密钥轮换的 cookie 带 `Secure`（`src/main/webPanel/auth.ts:158-190,223-233`）。因此同一受信 peer 不得把明文 HTTP 入口转给同一 backend；否则应用会错误地把明文请求视为 TLS 请求。

未 opt-in 的后果必须明确区分：

- `allowedIPs=[真实客户端 IP]`：应用实际比较代理 peer，合法客户端也会被拒绝；
- `allowedIPs=[代理 peer]`：所有由该代理转来的客户端都通过，白名单形同“允许整个入口”；
- `deniedIPs=[真实客户端 IP]`：不会命中，目标客户端仍可访问；
- 所有登录失败聚合到同一代理 IP 的限流桶，可能由一个攻击者影响其他管理员。

所以“前置层已传 `X-Forwarded-For`”不等于应用保护已生效；必须完成显式 opt-in 和双来源验收。

同机信任 `127.0.0.1` 也扩大了主机内信任边界：任何能从该地址连接 backend 的本机进程都能伪造转发链。不要在同一主机上运行不受信租户代码。异机代理不能继续把 backend 绑定 loopback；应绑定私网地址，防火墙只允许代理节点，并按后端实际观察到的源地址（含 SNAT 后地址）配置精确 IP，不能填写客户端网段。

## 防火墙

公网入站只应有：

- 22/tcp（或组织 SSH 入口，最好来源受限）；
- 80/tcp（仅给 ACME/跳转，若证书方案需要）；
- 443/tcp（Caddy）。

不得公网开放 5580、5590。以 UFW 为例：

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <管理网段> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 5580/tcp
sudo ufw deny 5590/tcp
sudo ufw enable
sudo ufw status verbose
```

再从另一台公网机器验证 5580/5590 超时或拒绝；服务器本机只验证监听地址，不把缺少代理元数据的 backend 直连当成功条件：

```sh
ss -ltnp | grep -E ':(443|5580|5590)\b'
```

unverified: UFW/nftables、云安全组、IPv6、Caddy/nginx header 重写和真实 TLS cookie 未在本 Windows 主机上执行。真实 Linux 验收必须同时从外部 IPv4、外部 IPv6、服务器本机和同 VPC 邻机测试；只看 `ufw status` 或配置文件不能证明云防火墙、容器端口发布和代理头净化没有被绕过。

## 哪些端点可公开

### 面板 vhost

`/panel/` 登录 shell 和登录 API 必须公开给需要管理的手机，但只经 HTTPS。除登录、静态 shell 和 readiness 外，业务 API 经过会话闸门；写操作还要求 `X-Panel-Request: 1`（`src/main/webPanel/auth.ts:193-216`；`src/main/webPanel/server.ts:313-377`）。

若管理人群固定，优先再加一层 VPN、Caddy 来源 IP 限制或身份感知代理。adminKey 是应用认证，不替代 TLS。

`GET /panel/readyz` 匿名是刻意设计，只返回：

```json
{ "status": "ready" }
```

或 503：

```json
{ "status": "not_ready" }
```

它不返回端口、账号数或错误原因，并带 `Cache-Control: no-store`（`src/main/webPanel/server.ts:313-322`）。公开它只泄露当前数据面是否 ready，可用于外部监控；如果组织不接受这一个布尔状态泄露，可在前置层限制监控来源，但不要给探针伪造面板会话。

不要把 `/panel/readyz` 配成 Caddy 对面板 upstream 的强制摘除条件：503 时面板是刻意保活的管理入口，摘除它会让操作员无法修复数据面。systemd unit 也明确把 process liveness 与 readiness 分开（`deploy/systemd/kiro-account-manager.service:19-28`）。

### API vhost

只公开实际客户端需要的兼容 API 路由（例如 `/v1/*`、`/anthropic/v1/*`、`/v1beta/models/*`），并配置代理 API key。代码对 `/health` 和 `/` 明确跳过 API key 校验（`src/main/proxy/proxyServer.ts:2438-2450`）。

`/health` 不是安全的公网探针：它返回账号总数、可用账号数及请求/token 等流量统计；路由同时把 `/` 映射到同一响应（`src/main/proxy/proxyServer.ts:2494-2495`，健康响应实现 `src/main/proxy/proxyServer.ts:2757-2774`）。因此 Caddy 示例同时屏蔽两者。

`/metrics` 和 `/admin/*` 即使当前位于 API key 闸门后，也不应暴露给普通代理客户端；管理接口与调用接口的授权域不同。前置层屏蔽比依赖每个客户端妥善保管高权限 API key更稳妥。

## 受信代理失败模式

- 变量未设置或为空：保持关闭，所有 forwarded headers 被忽略（`src/main/server/config.ts:170-183`；`src/main/utils/netGuard.ts:104-111`）。
- 变量包含空项、域名或非法 IP/CIDR：启动期退出 64，不静默回落（`src/main/server/config.ts:170-183`）。
- 请求来自已声明 peer，但没有合法 `X-Forwarded-For`：该请求返回 400（面板 `src/main/webPanel/server.ts:266-280`；数据反代 `src/main/proxy/proxyServer.ts:2412-2426`）。
- 声明了错误 peer：真实代理仍按未受信处理，IP policy 继续看到 socket 地址，cookie 不会获得 `Secure`。
- 同一受信 peer 同时转发 TLS 与明文：应用无法通过 `X-Forwarded-Proto` 区分，会错误地给明文路径签发 `Secure` cookie；这是部署合同错误。

生产装配已把环境声明注入两个 HTTP 入口（`src/main/server/assembly.ts:380-431,519-580`），但仍必须用真实 `front -> backend` hop 验收，不能只以“环境变量解析成功”作为上线依据。
