# TLS 前置、监听地址、转发头与防火墙

## 安全边界

本服务**不终止 TLS**。Node 面板和反代都是 HTTP；TLS 必须由同机前置代理承担（`src/main/server/entry.ts:42-50`）。因此：

- adminKey 经公网明文 HTTP 发送，等价于公开 adminKey；
- 会话 cookie 经公网明文 HTTP 发送，可被劫持；
- 不存在“先临时公网 HTTP 跑起来再补证书”的安全窗口。

初始默认均为 loopback：面板 `127.0.0.1:5590`、数据反代 `127.0.0.1:5580`（`src/main/server/assembly.ts:268-297`）。面板可用 `KIRO_PANEL_HOST`/`KIRO_PANEL_PORT` 覆盖，但生产应保留 loopback（`src/main/server/config.ts:65-79,149-153`）。反代 host/port 来自 `kiro-accounts.json` 的 `proxyConfig`，没有环境变量覆盖；迁移后必须核对目标副本（`src/main/server/assembly.ts:480-503`）。

## Canonical：Caddy

本文选 Caddy 作为唯一标准示例，原因是它默认自动申请/续期公开证书、默认启用安全 TLS 参数，配置较短，减少“服务已经公网开放但证书续期脚本还没装”的危险窗口。nginx 同样可用，但证书申请/续期、流式缓冲和下述路径拒绝规则必须由运维显式完成。

前提：

- `panel.example.com` 与 `api.example.com` 的 DNS 已指向服务器；
- TCP 80/443 可从公网到 Caddy；
- 5590/5580 只允许本机；
- 服务配置中的面板与反代 host 均为 `127.0.0.1`；
- adminKey 已按 `docs/operations/key-handling.md` 建立。

`/etc/caddy/Caddyfile`：

```caddyfile
panel.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:5590
}

api.example.com {
	@private path / /health /metrics /admin /admin/*
	respond @private 404

	reverse_proxy 127.0.0.1:5580 {
		# OpenAI/Anthropic/Gemini 流式响应应立即转发，不在前置层积攒。
		flush_interval -1
	}
}
```

检查后再加载：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -b --no-pager
curl -fsS https://panel.example.com/panel/readyz || true
curl -i https://api.example.com/health
```

第二条预期为 404；不能是带账号/统计的 200。随后通过浏览器登录面板并做一次受控流式代理请求。

Caddy 会向上游添加 `X-Forwarded-For/Proto/Host`，但当前服务不读取它们。面板 IP 取 `req.socket.remoteAddress`（`src/main/webPanel/server.ts:258-268`），反代同样只取 socket 地址并明确不信任 `X-Forwarded-For`（`src/main/proxy/proxyServer.ts:2246-2249`）。因此应用看到的客户端通常是 `127.0.0.1`，这是当前的安全默认，不要把“日志里都是 127.0.0.1”误判为 Caddy 配坏。

### nginx 用户必须改什么

不要再写第二份半成品示例。将同一合同翻译为 nginx 时，必须逐项实现：

1. 两个 TLS `server_name`，证书自动续期且续期失败有告警；
2. 两个 upstream 仍是 `127.0.0.1:5590/5580`；
3. API vhost 对 `/`、`/health`、`/metrics`、`/admin/` 在前置层返回 404/403；
4. 数据面关闭 `proxy_buffering`，并设置足够长的流式读超时；
5. 保留原始 Host，转发头可以发送，但服务不会信任；
6. reload 前跑 `nginx -t`，并执行与上面相同的外部验证。

## Forwarded headers：何时才可信

当前版本没有 `trustProxy` 配置，也没有解析 forwarded headers 的代码路径。不要在 Caddy/nginx 中把用户传入的 `X-Forwarded-For` 当成已验证身份，也不要根据该头放行管理端点。

只有未来同时满足以下条件时，代码才可以新增“信任转发头”模式：

- Node 监听仍只绑定 loopback/Unix socket，攻击者不能绕过前置代理直连；
- 代码只在 socket peer 属于明确的受信代理地址时读取转发头；
- 前置代理先删除客户端自带的 `Forwarded`/`X-Forwarded-*`，再写入自己的值；
- 正确解析多级代理链和最右侧受信 hop；
- 有伪造头、直连绕过和多代理链测试。

信任错误的风险不是“日志 IP 不准”而已：面板登录限流和 IP allow/deny 使用该 IP；攻击者若能伪造，就能绕过限流/黑名单，或伪装成白名单地址（面板调用见 `src/main/webPanel/server.ts:258-270`；共享 IP 策略见 `src/main/utils/netGuard.ts:144-150`）。当前经 Caddy 时所有请求聚合到 127.0.0.1，也意味着攻击者的连续失败可能锁住同一来源桶，影响合法管理员；应在前置层叠加独立限流/来源限制，但不能把 forwarded 头直接交给应用当修复。

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

再从另一台公网机器验证 5580/5590 超时或拒绝，从服务器本机验证 loopback 可达：

```sh
ss -ltnp | grep -E ':(443|5580|5590)\b'
curl -fsS http://127.0.0.1:5590/panel/readyz || true
```

unverified: UFW/nftables、云安全组、IPv6 和宿主机/容器网络规则未在本 Windows 主机上执行。真实 Linux 验收必须同时从外部 IPv4、外部 IPv6、服务器本机和同 VPC 邻机测试；只看 `ufw status` 不能证明云防火墙或容器端口发布没有绕过。

## 哪些端点可公开

### 面板 vhost

`/panel/` 登录 shell 和登录 API必须公开给需要管理的手机，但只经 HTTPS。除登录、静态 shell 和 readiness 外，业务 API 经过会话闸门；写操作还要求 `X-Panel-Request: 1`（`src/main/webPanel/auth.ts:176-199`；`src/main/webPanel/server.ts:322-353`）。

若管理人群固定，优先再加一层 VPN、Caddy 来源 IP 限制或身份感知代理。adminKey 是应用认证，不替代 TLS。

`GET /panel/readyz` 匿名是刻意设计，只返回：

```json
{ "status": "ready" }
```

或 503：

```json
{ "status": "not_ready" }
```

它不返回端口、账号数或错误原因，并带 `Cache-Control: no-store`（`src/main/webPanel/server.ts:289-298`）。公开它只泄露当前数据面是否 ready，可用于外部监控；如果组织不接受这一个布尔状态泄露，可在前置层限制监控来源，但不要给探针伪造面板会话。

不要把 `/panel/readyz` 配成 Caddy 对面板 upstream 的强制摘除条件：503 时面板是刻意保活的管理入口，摘除它会让操作员无法修复数据面。systemd unit 也明确把 process liveness 与 readiness 分开（`deploy/systemd/kiro-account-manager.service:19-28`）。

### API vhost

只公开实际客户端需要的兼容 API 路由（例如 `/v1/*`、`/anthropic/v1/*`、`/v1beta/models/*`），并配置代理 API key。代码对 `/health` 和 `/` 明确跳过 API key 校验（`src/main/proxy/proxyServer.ts:2408-2420`）。

`/health` 不是安全的公网探针：它返回账号总数、可用账号数及请求/token 等流量统计；路由同时把 `/` 映射到同一响应（`src/main/proxy/proxyServer.ts:2464-2465`，健康响应实现 `src/main/proxy/proxyServer.ts:2727-2744`）。因此 Caddy 示例同时屏蔽两者。

`/metrics` 和 `/admin/*` 即使当前位于 API key 闸门后，也不应暴露给普通代理客户端；管理接口与调用接口的授权域不同。前置层屏蔽比依赖每个客户端妥善保管高权限 API key更稳妥。

## 已知 TLS 前置限制

服务端装配使用 `new PanelAuth(adminKeyStore)`，没有注入 `isHttps`（`src/main/server/assembly.ts:371-383`）；默认 `isHttps()` 为 false（`src/main/webPanel/auth.ts:61-85`）。因此即使浏览器外侧是 HTTPS，当前会话 cookie 也不会带 `Secure` 属性，属性生成规则见 `src/main/webPanel/cookie.ts:26-44`。

这不是允许 HTTP 的理由。缓解措施是：

- Node 端严格 loopback；
- 防火墙禁止 5590；
- 只允许 Caddy 的 443 对外；
- 不提供同一域名的明文面板路径。

这是代码缺陷/硬化缺口，不应被文档伪装成已经解决；本任务按约束未修改 `src/**`。
