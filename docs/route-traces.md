# 去程与回程路由

服务器详情页可以读取 NextTrace 的测量结果。每台探测机可定时生成 JSON，也可以用测量服务接收网页请求并现场执行 NextTrace。两种方式都在主题设置里填数据源地址。

| 方向 | 运行采集脚本的机器 | `targetIp` |
| --- | --- | --- |
| `forward` 去程 | 国内测速节点，例如成都移动 | VPS 的 IPv4 或 IPv6 地址 |
| `return` 回程 | VPS | 所选国内测速节点的 IPv4 或 IPv6 地址 |

想看自己宽带的实际去程，就在接入那条宽带的机器上测。不同城市或运营商的节点测出来的是各自到 VPS 的路径。两侧用同一对公网地址测量，才能直接比较这对端点的两个方向。每一跳的 RTT 是从发起端到该跳回复的往返时间。

## 在线测去程

进入「服务器详情页 → 线路路由」，点「在线测去程」。填 VPS 的公网 IPv4 或 IPv6，选公共探测网络，再开始测量。Globalping 会发送探测包，页面直接显示它返回的线路。这个入口无需快照 URL 或自建探测机。

在 CFSM 页面内使用时，将 `https://api.globalping.io` 加到后台「外观设置 → CSP API 域名白名单」。也可以点「直接打开 Globalping」在公共网页上测试，省去站点配置。公开测试会向 Globalping 提交用户填写的 IP。

选择电信、联通或移动时分别匹配 AS4134、AS4837 或 AS9808。具体来源显示在结果上，节点是否在线由公共服务决定。第三方探测点可以测到 VPS 的去程。VPS 的实际回程请从那台 VPS 发起，使用下面的测量服务可以在网页中触发。

## 立即测量

使用下文的 `forward.json` 和 `return.json`。把仓库里的 `scripts/collect-routes.py`、`scripts/route_trace_server.py` 一起放到各自的探测机。

1. 在探测机上用 `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` 生成专用令牌。每台探测机可使用不同令牌。
2. 启动本机测量服务。把 `https://status.example.com` 换成 CFSM 监控页的源地址，包含协议和非默认端口。下列命令用 Bash 在国内探测机上运行。VPS 用 `return.json` 和它自己的令牌。

   ```bash
   read -r -s -p '测量令牌: ' ROUTE_TRACE_TOKEN
   export ROUTE_TRACE_TOKEN
   python3 scripts/collect-routes.py forward.json ./latest.json \
     --serve --origin https://status.example.com
   ```

3. 服务监听 `127.0.0.1:8765`。用现有的 HTTPS 反向代理提供 `snapshot.json`（读取线路和最近结果）及同目录下的 `measure`（发起测量）。以下示例放在探测机的 HTTPS Nginx 虚拟主机中。

   ```nginx
   location = /route-probe/snapshot.json {
       proxy_pass http://127.0.0.1:8765/snapshot.json;
   }
   location = /route-probe/measure {
       client_max_body_size 128;
       proxy_read_timeout 75s;
       proxy_pass http://127.0.0.1:8765/measure;
   }
   ```

4. 把两台探测机的 `https://探测机域名/route-probe/snapshot.json` 各填一行到「主题设置 → 服务器 → 网络延迟 → 线路路由快照 URL」。跨域时，CFSM 的 CSP API 域名列表也要允许这两个 HTTPS 源。服务按 `--origin` 返回 CORS 响应。
5. 登录监控页，在服务器详情页展开「线路路由」，选方向、IP 协议和测量线路，点「立即测量」。输入页面显示的那台探测机的专用令牌，再点「开始测量」。

这个模式可以从空记录开始。命令结束时，页面直接更新结果，探测机也会保存最近记录。每台探测机同时执行一项测量，下一项在前一项结束十秒后可再次启动。快照地址可公开读取，请在配置中使用你打算公开的测量目标。令牌留在探测机上，网页仅在开始测量时向所选探测机发送你手动输入的令牌。定时采集和测量服务若同时使用，应分别使用各自的快照文件。

## 采集

在 Linux 测量机上安装 Python 3.9+ 和 [NextTrace](https://github.com/nxtrace/NTrace-core/releases)。先确认运行用户拥有 NextTrace 所需的网络权限，并能手动执行一条 `nexttrace --json --map --no-rdns <目标IP>`。下面的 IP 是文档示例，请换为实际可测地址。

在国内测量机上创建 `forward.json`。`nodeId` 取服务器详情页 `/#/server/` 后面的节点 ID，也可从 CFSM 的 `/api/servers` 返回的 `id` 读取。

```json
{
  "source": "成都移动",
  "targets": [
    {
      "nodeId": "tokyo-vps",
      "direction": "forward",
      "destination": "东京 VPS",
      "targetIp": "203.0.113.10",
      "protocol": "tcp",
      "port": 443
    },
    {
      "nodeId": "tokyo-vps",
      "direction": "forward",
      "destination": "东京 VPS",
      "targetIp": "2001:db8:1::10"
    }
  ]
}
```

在东京 VPS 上创建 `return.json`，使用同一个 `nodeId`。

```json
{
  "source": "东京 VPS",
  "targets": [
    {
      "nodeId": "tokyo-vps",
      "direction": "return",
      "destination": "成都移动",
      "targetIp": "198.51.100.20"
    },
    {
      "nodeId": "tokyo-vps",
      "direction": "return",
      "destination": "成都移动",
      "targetIp": "2001:db8:2::20"
    }
  ]
}
```

默认使用 ICMP。选 TCP 或 UDP 时填目标端口。探针所在机器需要具备对应的 IPv4 / IPv6 连通性。运营商、ASN 和地区取自 NextTrace 的地理数据源。默认使用 `NextTrace-API`，也可在配置顶层用 `"dataProvider": "disable-geoip"` 只采集 IP 和 RTT。

在国内测量机上执行，生成成都节点的快照。

```bash
python3 scripts/collect-routes.py forward.json /var/www/routes/chengdu-mobile.json
```

在 VPS 上执行，生成东京节点的快照。

```bash
python3 scripts/collect-routes.py return.json /var/www/routes/tokyo-vps.json
```

每份快照最多 32 项测量，单项最多 30 跳。脚本逐项运行并原子替换输出文件。单项执行失败时，快照会保留该项的失败状态。可以通过 cron 或 systemd timer 每 30 分钟执行，并用 `flock` 或定时器避免同一采集任务重叠运行。按同样方式增加电信、联通以及其他地区的测量点。

## 发布和配置

1. 通过已有的 HTTPS 静态站提供这些 JSON，或把各台机器生成的文件同步到同一个静态目录。快照包含目标与各跳 IP，发布前确认这些信息可以公开。
2. 若快照与主题站点跨域，静态站需要允许主题站点的 CORS 请求，例如响应 `Access-Control-Allow-Origin: https://status.example.com`。CFSM 后台启用了 CSP 时，在「外观设置」的 CSP API 域名列表中添加快照所在的 HTTPS 源，例如 `https://routes.example.com`。使用公开仓库的 `raw.githubusercontent.com` 文件也可以，CFSM 的默认 CSP 已允许该域名。
3. 打开「主题设置 → 服务器 → 网络延迟 → 线路路由快照 URL」。每行填一个可直接访问的 JSON 地址，最多 12 个。已有同源静态服务时也可以填 `/routes/chengdu-mobile.json` 这样的绝对路径。URL 不接受重定向、账号密码或查询参数。
4. 打开对应节点详情页，点「查看路由」，切换去程、回程、IPv4、IPv6 和测量线路。「刷新结果」重新读取快照。需要按需测量时，接入上面的测量服务。

从首页点击服务器名字进入详情页。「线路路由」在图表下方，未配置时会显示提示，登录站长可以点击「配置路由」直达主题设置的「服务器」页。

也可以把这一字段合并到后台「外观设置 → 主题自定义配置」，保留已有字段。

```json
{
  "routeTraceUrls": "https://routes.example.com/chengdu-mobile.json\nhttps://routes.example.com/tokyo-vps.json"
}
```

详情页只显示当前节点 ID 匹配的测量记录。同一来源、方向、目标 IP 和探测方式有多份记录时，取测量时间最新的一条。快照超过 24 小时时会在页内显示。如页面显示加载失败，先检查 URL 能否直接返回 JSON，再检查浏览器控制台的 CORS 或 CSP 错误。快照上限为 1 MiB。

## 本地预览

运行 `npm run dev` 后，访问 `http://localhost:5173/?mock=1&routes=1#/server/tokyo-edge-01`。详情页使用标明「模拟」的样本显示去程、回程、IPv4 和 IPv6。
