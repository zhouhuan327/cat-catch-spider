#!/usr/bin/env node
/**
 * Cat-Catch Bridge Server
 *
 * 作为浏览器扩展和外部工具（如 openclaw/Claude）之间的 HTTP 桥接层。
 *
 * 扩展 → bridge：每隔几秒 POST /media 推送嗅探到的媒体
 * 扩展 → bridge：每隔几秒 GET /download-queue 拉取待下载任务
 * 外部 → bridge：GET /media 查询已嗅探到的媒体列表
 * 外部 → bridge：POST /download 提交下载请求
 *
 * 启动方式：node bridge/server.js [--port 3399]
 */

const http = require("http");
const { URL } = require("url");

// 从命令行参数读端口，默认 3399
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg !== -1 ? parseInt(args[portArg + 1]) : 3399;

// 内存存储
const mediaStore = new Map();   // key: url → media info
const downloadQueue = [];        // 待下载任务队列

// 媒体条目最多保留 500 条，避免无限增长
const MAX_MEDIA = 500;

function addMedia(info) {
    if (!info || !info.url) return;
    // 已存在则更新，否则追加
    mediaStore.set(info.url, { ...info, receivedAt: Date.now() });
    // 超量时删掉最老的
    if (mediaStore.size > MAX_MEDIA) {
        const oldest = mediaStore.keys().next().value;
        mediaStore.delete(oldest);
    }
}

function getMediaList({ ext, type, limit } = {}) {
    let list = Array.from(mediaStore.values())
        .sort((a, b) => b.receivedAt - a.receivedAt);
    if (ext) list = list.filter(m => m.ext === ext);
    if (type) list = list.filter(m => String(m.type) === String(type));
    if (limit) list = list.slice(0, parseInt(limit));
    return list;
}

// 解析请求体 JSON
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}

function send(res, status, data) {
    const json = JSON.stringify(data, null, 2);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        // 允许扩展 service worker 跨域访问
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(json);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
    }

    // ── GET /media ──────────────────────────────────────────────────────────
    // 返回已嗅探到的媒体列表
    // 可选查询参数：ext=m3u8 | type=0 | limit=20
    if (method === "GET" && path === "/media") {
        const ext   = url.searchParams.get("ext") || undefined;
        const type  = url.searchParams.get("type") || undefined;
        const limit = url.searchParams.get("limit") || undefined;
        send(res, 200, { total: mediaStore.size, media: getMediaList({ ext, type, limit }) });
        return;
    }

    // ── POST /media ──────────────────────────────────────────────────────────
    // 扩展推送嗅探到的媒体（单条或数组）
    if (method === "POST" && path === "/media") {
        let body;
        try { body = await readBody(req); }
        catch { send(res, 400, { error: "invalid json" }); return; }

        const items = Array.isArray(body) ? body : [body];
        items.forEach(addMedia);
        send(res, 200, { ok: true, added: items.length });
        return;
    }

    // ── DELETE /media ─────────────────────────────────────────────────────────
    // 清空媒体缓存
    if (method === "DELETE" && path === "/media") {
        mediaStore.clear();
        send(res, 200, { ok: true });
        return;
    }

    // ── POST /download ────────────────────────────────────────────────────────
    // 外部（openclaw）提交下载任务
    // Body: { url, headers, title, ext, type, ... }
    //   或  { url }  最简形式
    if (method === "POST" && path === "/download") {
        let body;
        try { body = await readBody(req); }
        catch { send(res, 400, { error: "invalid json" }); return; }

        if (!body.url) { send(res, 400, { error: "url is required" }); return; }

        const task = {
            id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
            url: body.url,
            title: body.title || "",
            ext: body.ext || "",
            type: body.type ?? 0,
            headers: body.headers || {},
            requestedAt: Date.now(),
        };
        downloadQueue.push(task);
        console.log(`[bridge] download queued: ${task.url}`);
        send(res, 200, { ok: true, taskId: task.id });
        return;
    }

    // ── GET /download-queue ───────────────────────────────────────────────────
    // 扩展轮询：取出所有待下载任务（取出后即清空队列）
    if (method === "GET" && path === "/download-queue") {
        const tasks = downloadQueue.splice(0, downloadQueue.length);
        send(res, 200, { tasks });
        return;
    }

    // ── GET /status ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/status") {
        send(res, 200, { ok: true, mediaCount: mediaStore.size, queueLength: downloadQueue.length });
        return;
    }

    send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[cat-catch bridge] listening on http://127.0.0.1:${PORT}`);
    console.log(`  GET  /media            — 查询嗅探到的媒体列表`);
    console.log(`  POST /media            — 扩展推送媒体（自动调用）`);
    console.log(`  POST /download         — 提交下载任务`);
    console.log(`  GET  /download-queue   — 扩展轮询取任务（自动调用）`);
    console.log(`  GET  /status           — 服务状态`);
});

server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
        console.error(`[bridge] port ${PORT} already in use. Try: node server.js --port 3400`);
    } else {
        console.error("[bridge] error:", e.message);
    }
    process.exit(1);
});
