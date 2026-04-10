# Cat-Catch Bridge

本地 HTTP 桥接服务，让外部工具（AI 助手、脚本等）能够：

1. **查询**猫抓扩展当前嗅探到的媒体资源
2. **触发**扩展下载指定资源

## 工作原理

```
浏览器页面
  └─ 猫抓扩展嗅探到媒体
       └─ POST /media ──▶ bridge server（本进程）
                               ▲
外部工具（AI / 脚本）           │
  ├─ GET  /media  ─────────────┘  查询已嗅探到的资源
  └─ POST /download ──▶ bridge server
                          └─ 入队
                               ▲
猫抓扩展每 N 秒轮询 ────────────┘  GET /download-queue
  └─ 取到任务 → chrome.downloads 触发下载
```

## 快速启动

```bash
node bridge/server.js
# 默认监听 http://127.0.0.1:3399
# 指定端口：node bridge/server.js --port 3400
```

## 扩展配置

打开猫抓**设置页** → 找到 **Bridge** 区块：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| 启用 Bridge | 总开关 | 关 |
| 推送嗅探到的媒体 | 每次嗅探到资源自动推送到 bridge | 开 |
| Bridge 服务地址 | bridge server 的 URL | `http://127.0.0.1:3399` |
| 轮询间隔（秒） | 扩展多久取一次下载队列 | 5 秒 |

## API 接口

### GET /status
检查服务是否在运行。

```bash
curl http://127.0.0.1:3399/status
```

```json
{ "ok": true, "mediaCount": 3, "queueLength": 0 }
```

---

### GET /media
获取当前所有已嗅探到的媒体列表。

```bash
curl http://127.0.0.1:3399/media
```

**可选查询参数：**

| 参数 | 说明 | 示例 |
|------|------|------|
| `ext` | 按后缀过滤 | `?ext=m3u8` |
| `type` | 按 MIME 类型过滤 | `?type=video/mp4` |
| `limit` | 最多返回 N 条 | `?limit=10` |

**返回示例：**

```json
{
  "total": 1,
  "media": [
    {
      "url": "https://example.com/video.mp4",
      "title": "视频标题",
      "ext": "mp4",
      "type": "video/mp4",
      "size": 4450237,
      "name": "文件名.mp4",
      "tabId": 123,
      "pageUrl": "https://www.example.com/post/xxx",
      "requestHeaders": [...],
      "receivedAt": 1775812030125
    }
  ]
}
```

---

### POST /download
提交一个下载任务，扩展会在下次轮询时执行。

```bash
curl -X POST http://127.0.0.1:3399/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/video.mp4", "title": "视频标题", "ext": "mp4"}'
```

**请求体字段：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | 要下载的资源 URL |
| `title` | 否 | 文件名（不含后缀） |
| `ext` | 否 | 文件后缀，m3u8/mpd 会自动走解析页 |
| `type` | 否 | MIME 类型 |
| `headers` | 否 | 自定义请求头 `{"Referer": "..."}` |

**返回：**

```json
{ "ok": true, "taskId": "1775812080947_n0wc" }
```

---

### DELETE /media
清空媒体缓存。

```bash
curl -X DELETE http://127.0.0.1:3399/media
```

## 典型使用流程（AI 助手）

### 场景：用户分享了一个视频页面，让 AI 帮忙下载

1. **用户** 在浏览器打开视频页面，猫抓自动嗅探
2. **AI** 调用 `GET /media` 查看嗅探到了什么
3. **AI** 找到目标资源，调用 `POST /download` 提交任务
4. **扩展** 轮询到任务，触发 Chrome 下载

```
用户："帮我下载这个视频 https://www.xiaohongshu.com/explore/xxx"

AI 工具调用：
  1. GET /media?limit=5          → 找到 video.mp4
  2. POST /download {"url": "https://cdn.example.com/video.mp4", "title": "xxx"}

结果：Chrome 下载栏出现文件
```

### 场景：直接给 URL 让 AI 下载

如果 AI 直接拿到了资源 URL（从页面源码、API 等），可以跳过查询步骤，直接 `POST /download`。

## 注意事项

- bridge server 是**本地进程**，需要手动启动，或配置开机自启
- 扩展的轮询基于 `setInterval`，Service Worker 被浏览器休眠后定时器会停止，重新点击扩展图标可唤醒
- 媒体缓存最多保留 500 条，超出后自动删除最早的
- bridge server 没有鉴权，仅监听 `127.0.0.1`，不对外网暴露
