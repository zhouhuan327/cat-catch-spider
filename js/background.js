importScripts("/js/function.js", "/js/init.js");

// Service Worker 5分钟后会强制终止扩展
// https://bugs.chromium.org/p/chromium/issues/detail?id=1271154
// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension/70003493#70003493
chrome.webNavigation.onBeforeNavigate.addListener(function () { return; });
chrome.webNavigation.onHistoryStateUpdated.addListener(function () { return; });
chrome.runtime.onConnect.addListener(function (Port) {
    if (chrome.runtime.lastError || Port.name !== "HeartBeat") return;
    Port.postMessage("HeartBeat");
    Port.onMessage.addListener(function (message, Port) { return; });
    const interval = setInterval(function () {
        clearInterval(interval);
        Port.disconnect();
    }, 250000);
    Port.onDisconnect.addListener(function () {
        interval && clearInterval(interval);
        if (chrome.runtime.lastError) { return; }
    });
});

/**
 *  定时任务
 *  nowClear clear 清理冗余数据
 *  save 保存数据
 */
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === "nowClear" || alarm.name === "clear") {
        clearRedundant();
        return;
    }
    if (alarm.name === "save") {
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }
});

/**
 * 向桥接服务推送一条媒体信息
 * @param {Object} info 媒体对象
 */
function bridgePushMedia(info) {
    if (!G.bridge || !G.bridgePushMedia) return;
    const payload = {
        url: info.url,
        title: info.title,
        ext: info.ext,
        type: info.type,
        size: info.size,
        duration: info.duration,
        name: info.name,
        tabId: info.tabId,
        pageUrl: info.pageUrl,
        requestHeaders: info.requestHeaders,
    };
    fetch(G.bridgeURL + "/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).catch(() => { /* 桥接服务未启动时静默忽略 */ });
}

/**
 * 轮询桥接服务的下载队列，取到任务后触发下载
 */
function bridgePollQueue() {
    if (!G.bridge) return;
    fetch(G.bridgeURL + "/download-queue")
        .then(r => r.json())
        .then(function (data) {
            if (!data.tasks || !data.tasks.length) return;
            for (const task of data.tasks) {
                bridgeExecuteDownload(task);
            }
        })
        .catch(() => { /* 桥接服务未启动时静默忽略 */ });
}

/**
 * 执行一条桥接下来的下载任务
 * @param {Object} task { url, title, ext, type, headers }
 */
function bridgeExecuteDownload(task) {
    if (!task.url) return;
    // m3u8 / mpd 走解析页
    const ext = (task.ext || "").toLowerCase();
    const isStream = ext === "m3u8" || ext === "mpd" || task.url.includes(".m3u8") || task.url.includes(".mpd");
    if (isStream) {
        openParser(task);
        return;
    }
    // 普通文件直接触发浏览器下载
    const fileName = task.title ? task.title + (ext ? "." + ext : "") : undefined;
    chrome.downloads.download({
        url: task.url,
        filename: fileName,
    });
}

// bridge 轮询定时器（setInterval，支持 <1min 的间隔）
var bridgePollTimer = null;

/**
 * 根据 bridgePollInterval 配置启动/停止轮询定时器
 * Service Worker 存活期间有效；每次 SW 被唤醒后 init 会重新调用
 */
function bridgeSetupPoll() {
    if (bridgePollTimer) {
        clearInterval(bridgePollTimer);
        bridgePollTimer = null;
    }
    if (!G.bridge) return;
    const ms = Math.max(2, G.bridgePollInterval || 5) * 1000;
    bridgePollTimer = setInterval(bridgePollQueue, ms);
}

// onBeforeRequest 浏览器发送请求之前使用正则匹配发送请求的URL
// chrome.webRequest.onBeforeRequest.addListener(
//     function (data) {
//         try { findMedia(data, true); } catch (e) { console.log(e); }
//     }, { urls: ["<all_urls>"] }, ["requestBody"]
// );
// 保存requestHeaders
chrome.webRequest.onSendHeaders.addListener(
    function (data) {
        if (G && G.initSyncComplete && !G.enable) { return; }
        if (data.requestHeaders) {
            G.requestHeaders.set(data.requestId, data.requestHeaders);
            data.allRequestHeaders = data.requestHeaders;
        }
        try { findMedia(data, true); } catch (e) { console.log(e); }
    }, { urls: ["<all_urls>"] }, ['requestHeaders',
        chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);
// onResponseStarted 浏览器接收到第一个字节触发，保证有更多信息判断资源类型
chrome.webRequest.onResponseStarted.addListener(
    function (data) {
        try {
            data.allRequestHeaders = G.requestHeaders.get(data.requestId);
            if (data.allRequestHeaders) {
                G.requestHeaders.delete(data.requestId);
            }
            findMedia(data);
        } catch (e) { console.log(e, data); }
    }, { urls: ["<all_urls>"] }, ["responseHeaders"]
);
// 删除失败的requestHeadersData
chrome.webRequest.onErrorOccurred.addListener(
    function (data) {
        G.requestHeaders.delete(data.requestId);
        G.blackList.delete(data.requestId);
    }, { urls: ["<all_urls>"] }
);

function findMedia(data, isRegex = false, filter = false, timer = false) {
    // Service Worker被强行杀死之后重新自我唤醒，等待全局变量初始化完成。
    if (!G || !G.initSyncComplete || !G.initLocalComplete || G.tabId == undefined || cacheData.init) {
        if (timer) { return; }
        setTimeout(() => {
            findMedia(data, isRegex, filter, true);
        }, 500);
        return;
    }

    if (G.damn && G.damnUrlSet.has(data.tabId)) {
        return;
    }

    // 检查 是否启用 是否在当前标签是否在屏蔽列表中
    const blockUrlFlag = data.tabId && data.tabId > 0 && G.blockUrlSet.has(data.tabId);
    if (!G.enable || (G.blockUrlWhite ? !blockUrlFlag : blockUrlFlag)) {
        return;
    }

    data.getTime = Date.now();

    if (!isRegex && G.blackList.has(data.requestId)) {
        G.blackList.delete(data.requestId);
        return;
    }
    // 屏蔽特殊页面发起的资源
    if (data.initiator != "null" &&
        data.initiator != undefined &&
        isSpecialPage(data.initiator)) { return; }
    if (G.isFirefox &&
        data.originUrl &&
        isSpecialPage(data.originUrl)) { return; }
    // 屏蔽特殊页面的资源
    if (isSpecialPage(data.url)) { return; }
    const urlParsing = new URL(data.url);
    let [name, ext] = fileNameParse(urlParsing.pathname);

    //正则匹配
    if (isRegex && !filter) {
        for (let key in G.Regex) {
            if (!G.Regex[key].state) { continue; }
            G.Regex[key].regex.lastIndex = 0;
            let result = G.Regex[key].regex.exec(data.url);
            if (result == null) { continue; }
            if (G.Regex[key].blackList) {
                G.blackList.add(data.requestId);
                return;
            }
            data.extraExt = G.Regex[key].ext ? G.Regex[key].ext : undefined;
            if (result.length == 1) {
                findMedia(data, true, true);
                return;
            }
            result.shift();
            result = result.map(str => decodeURIComponent(str));
            if (!result[0].startsWith('https://') && !result[0].startsWith('http://')) {
                result[0] = urlParsing.protocol + "//" + data.url;
            }
            data.url = result.join("");
            findMedia(data, true, true);
            return;
        }
        return;
    }

    // 非正则匹配
    if (!isRegex) {
        // 获取头部信息
        data.header = getResponseHeadersValue(data);
        //检查后缀
        if (!filter && ext != undefined) {
            filter = CheckExtension(ext, data.header?.size);
            if (filter == "break") { return; }
        }
        //检查类型
        if (!filter && data.header?.type != undefined) {
            filter = CheckType(data.header.type, data.header?.size);
            if (filter == "break") { return; }
        }
        //查找附件
        if (!filter && data.header?.attachment != undefined) {
            const res = data.header.attachment.match(reFilename);
            if (res && res[1]) {
                [name, ext] = fileNameParse(decodeURIComponent(res[1]));
                filter = CheckExtension(ext, 0);
                if (filter == "break") { return; }
            }
        }
        //放过类型为media的资源
        if (data.type == "media") {
            filter = true;
        }
    }

    if (!filter) { return; }

    // 谜之原因 获取得资源 tabId可能为 -1 firefox中则正常
    // 检查是 -1 使用当前激活标签得tabID
    data.tabId = data.tabId == -1 ? G.tabId : data.tabId;

    cacheData[data.tabId] ??= [];
    cacheData[G.tabId] ??= [];

    // 缓存数据大于9999条 清空缓存 避免内存占用过多
    if (cacheData[data.tabId].length > G.maxLength) {
        cacheData[data.tabId] = [];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }

    // 查重 避免CPU占用 大于500 强制关闭查重
    // if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
    //     for (let item of cacheData[data.tabId]) {
    //         if (item.url.length == data.url.length &&
    //             item.cacheURL.pathname == urlParsing.pathname &&
    //             item.cacheURL.host == urlParsing.host &&
    //             item.cacheURL.search == urlParsing.search) { return; }
    //     }
    // }

    if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
        const tabFingerprints = G.urlMap.get(data.tabId) || new Set();
        if (tabFingerprints.has(data.url)) {
            return; // 找到重复，直接返回
        }
        tabFingerprints.add(data.url);
        G.urlMap.set(data.tabId, tabFingerprints);
        if (tabFingerprints.size >= 500) {
            tabFingerprints.clear();
        }
    }

    chrome.tabs.get(data.tabId, async function (webInfo) {
        if (chrome.runtime.lastError) { return; }
        data.requestHeaders = getRequestHeaders(data);
        // requestHeaders 中cookie 单独列出来
        if (data.requestHeaders?.cookie) {
            data.cookie = data.requestHeaders.cookie;
            data.requestHeaders.cookie = undefined;
        }
        let info = {
            name: name,
            url: data.url,
            size: data.header?.size,
            ext: ext,
            type: data.mime ?? data.header?.type,
            tabId: data.tabId,
            isRegex: isRegex,
            requestId: data.requestId ?? Date.now().toString(),
            initiator: data.initiator,
            requestHeaders: data.requestHeaders,
            cookie: data.cookie,
            // cacheURL: { host: urlParsing.host, search: urlParsing.search, pathname: urlParsing.pathname },
            getTime: data.getTime
        };
        // 不存在扩展使用类型
        if (info.ext === undefined && info.type !== undefined) {
            info.ext = info.type.split("/")[1];
        }
        // 正则匹配的备注扩展
        if (data.extraExt) {
            info.ext = data.extraExt;
        }
        // 不存在 initiator 和 referer 使用web url代替initiator
        if (info.initiator == undefined || info.initiator == "null") {
            info.initiator = info.requestHeaders?.referer ?? webInfo?.url;
        }
        // 装载页面信息
        info.title = webInfo?.title ?? "NULL";
        info.pageTitle = info.title;
        info.favIconUrl = webInfo?.favIconUrl;
        info.webUrl = webInfo?.url;
        // 屏蔽资源
        if (!isRegex && G.blackList.has(data.requestId)) {
            G.blackList.delete(data.requestId);
            return;
        }
        getTabPageMeta(info.tabId, webInfo, function (pageMeta) {
            if (pageMeta) {
                info = mergePageMeta(info, pageMeta);
            }
            // 发送到popup 并检查自动下载
            chrome.runtime.sendMessage({ Message: "popupAddData", data: info }, function () {
                if (G.featAutoDownTabId.size > 0 && G.featAutoDownTabId.has(info.tabId) && chrome.downloads?.State) {
                    try {
                        const downDir = info.title == "NULL" ? "CatCatch/" : stringModify(info.title) + "/";
                        let fileName = isEmpty(info.name) ? stringModify(info.title) + '.' + info.ext : decodeURIComponent(stringModify(info.name));
                        if (G.TitleName) {
                            fileName = filterFileName(templates(G.downFileName, info));
                        } else {
                            fileName = downDir + fileName;
                        }
                        chrome.downloads.download({
                            url: info.url,
                            filename: fileName
                        });
                    } catch (e) { return; }
                }
                if (chrome.runtime.lastError) { return; }
            });

            // 数据发送
            if (G.send2local) {
                try { send2local("catch", { ...info, requestHeaders: data.allRequestHeaders }, info.tabId); } catch (e) { console.log(e); }
            }

            // 推送到桥接服务
            bridgePushMedia({ ...info, requestHeaders: data.allRequestHeaders });

            // 储存数据
            cacheData[info.tabId] ??= [];
            cacheData[info.tabId].push(info);

            // 当前标签媒体数量大于100 开启防抖 等待5秒储存 或 积累10个资源储存一次。
            if (cacheData[info.tabId].length >= 100 && debounceCount <= 10) {
                debounceCount++;
                clearTimeout(debounce);
                debounce = setTimeout(function () { save(info.tabId); }, 5000);
                return;
            }
            // 时间间隔小于500毫秒 等待2秒储存
            if (Date.now() - debounceTime <= 500) {
                clearTimeout(debounce);
                debounceTime = Date.now();
                debounce = setTimeout(function () { save(info.tabId); }, 2000);
                return;
            }
            save(info.tabId);
        });
    });
}
function shouldCapturePageMeta(url) {
    if (!url) { return false; }
    try {
        return /(^|\.)xiaohongshu\.com$/i.test(new URL(url).hostname);
    } catch (e) {
        return false;
    }
}
function hasMeaningfulPageMeta(pageMeta) {
    if (!pageMeta || typeof pageMeta != "object") { return false; }
    return Boolean(
        pageMeta.noteTitle ||
        pageMeta.noteDesc ||
        pageMeta.authorName ||
        pageMeta.likeCount ||
        pageMeta.collectCount ||
        pageMeta.commentCount ||
        pageMeta.shareCount ||
        pageMeta.noteId
    );
}
function hasPreferredXhsPageMeta(pageMeta) {
    if (!pageMeta || typeof pageMeta != "object") { return false; }
    return Boolean(
        pageMeta.authorName ||
        pageMeta.likeCount ||
        pageMeta.collectCount ||
        pageMeta.commentCount ||
        pageMeta.shareCount
    );
}
function getTabPageMeta(tabId, webInfo, callback) {
    if (!tabId || tabId <= 0 || !shouldCapturePageMeta(webInfo?.url)) {
        callback(false);
        return;
    }
    let retryCount = 0;
    const maxRetry = 20;
    const retryDelay = 400;
    // 向指定 frameId 发消息，返回 Promise<pageMeta|null>
    const fetchFromFrame = function (frameId) {
        return new Promise(function (resolve) {
            const options = frameId != null ? { frameId } : {};
            chrome.tabs.sendMessage(tabId, { Message: "getPageMeta" }, options, function (pageMeta) {
                if (chrome.runtime.lastError || !pageMeta || typeof pageMeta != "object") {
                    resolve(null);
                } else {
                    resolve(pageMeta);
                }
            });
        });
    };
    const tryFetch = function () {
        // 先问主框架（frameId:0），拿不到 preferred meta 时再遍历所有子框架
        fetchFromFrame(0).then(function (pageMeta) {
            if (hasPreferredXhsPageMeta(pageMeta)) {
                G.pageMetaCache.set(tabId, { url: webInfo?.url, time: Date.now(), data: pageMeta });
                callback(pageMeta);
                return;
            }
            // 主框架没有，查子框架（XHS 详情弹窗在同源 iframe 内）
            chrome.webNavigation.getAllFrames({ tabId }, function (frames) {
                if (chrome.runtime.lastError || !frames) {
                    finalize(pageMeta);
                    return;
                }
                const subFrames = frames.filter(f => f.frameId !== 0);
                if (!subFrames.length) { finalize(pageMeta); return; }
                Promise.all(subFrames.map(f => fetchFromFrame(f.frameId))).then(function (results) {
                    const best = results.find(r => hasPreferredXhsPageMeta(r))
                        || results.find(r => hasMeaningfulPageMeta(r))
                        || pageMeta;
                    finalize(best);
                });
            });
        });
    };
    const finalize = function (pageMeta) {
        const hasMeta = hasMeaningfulPageMeta(pageMeta);
        const hasPreferredMeta = hasPreferredXhsPageMeta(pageMeta);
        if (hasPreferredMeta || (hasMeta && retryCount >= maxRetry - 1)) {
            G.pageMetaCache.set(tabId, { url: webInfo?.url, time: Date.now(), data: pageMeta });
            callback(pageMeta);
            return;
        }
        retryCount++;
        if (retryCount >= maxRetry) {
            callback({
                site: "xiaohongshu",
                pageUrl: webInfo?.url,
                pageTitle: webInfo?.title || "",
                title: webInfo?.title || "",
                extractor: "missing",
                metaStatus: "missing"
            });
            return;
        }
        setTimeout(tryFetch, retryDelay);
    };
    tryFetch();
}
function shouldUpdateMediaWithPageMeta(info, pageMeta) {
    if (!info || !pageMeta || pageMeta.site != "xiaohongshu") { return false; }
    // 两边都有 noteId 且不同，明确不属于同一笔记
    if (info.noteId && pageMeta.noteId && info.noteId != pageMeta.noteId) { return false; }
    // pageMeta 有 noteId 但 info 没有：
    // - 若 info 已有其他有效 meta，说明属于另一个笔记，不覆盖
    // - 若 info 完全没有 meta 但 pageUrl 指向不同笔记，也不覆盖
    if (pageMeta.noteId && !info.noteId) {
        if (hasPreferredXhsPageMeta(info)) { return false; }
        const infoNoteId = info.pageUrl && info.pageUrl.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/i)?.[1];
        if (infoNoteId && infoNoteId != pageMeta.noteId) { return false; }
    }
    const missingMeta = !info.noteTitle && !info.noteDesc && !info.authorName && !info.likeCount && !info.collectCount && !info.commentCount && !info.shareCount;
    const hasRicherMeta = Boolean(
        (pageMeta.authorName && pageMeta.authorName != info.authorName) ||
        (pageMeta.likeCount && pageMeta.likeCount != info.likeCount) ||
        (pageMeta.collectCount && pageMeta.collectCount != info.collectCount) ||
        (pageMeta.commentCount && pageMeta.commentCount != info.commentCount) ||
        (pageMeta.shareCount && pageMeta.shareCount != info.shareCount) ||
        (pageMeta.noteDesc && pageMeta.noteDesc != info.noteDesc)
    );
    return info.metaStatus == "missing" || missingMeta || shouldReplaceOpaqueName(info.name, info.ext) || hasRicherMeta;
}
function getMediaMetaSignature(info) {
    return [
        info?.title || "",
        info?.name || "",
        info?.pageTitle || "",
        info?.pagePath || "",
        info?.noteId || "",
        info?.noteTitle || "",
        info?.noteDesc || "",
        info?.authorName || "",
        info?.likeCount || "",
        info?.collectCount || "",
        info?.commentCount || "",
        info?.shareCount || "",
        info?.metaStatus || ""
    ].join("::");
}
function updateCachedMediaWithPageMeta(tabId, pageMeta) {
    if (!tabId || !hasMeaningfulPageMeta(pageMeta) || !cacheData[tabId]?.length) { return []; }
    const updatedItems = [];
    cacheData[tabId] = cacheData[tabId].map(function (item) {
        if (!shouldUpdateMediaWithPageMeta(item, pageMeta)) {
            return item;
        }
        const merged = mergePageMeta({ ...item }, pageMeta);
        if (getMediaMetaSignature(item) == getMediaMetaSignature(merged)) {
            return item;
        }
        updatedItems.push(merged);
        return merged;
    });
    if (!updatedItems.length) { return updatedItems; }
    save(tabId);
    updatedItems.forEach(function (item) {
        chrome.runtime.sendMessage({ Message: "popupUpdateData", data: item }, function () {
            void chrome.runtime.lastError;
        });
    });
    return updatedItems;
}
function mergePageMeta(info, pageMeta) {
    if (!pageMeta) { return info; }
    info.site = pageMeta.site || info.site;
    info.pageUrl = pageMeta.pageUrl || info.webUrl;
    info.pagePath = pageMeta.pagePath || "";
    info.extractor = pageMeta.extractor || "";
    info.noteId = pageMeta.noteId || info.noteId;
    info.noteTitle = pageMeta.noteTitle || info.noteTitle || "";
    info.noteDesc = pageMeta.noteDesc || info.noteDesc || "";
    info.authorName = pageMeta.authorName || info.authorName || "";
    info.likeCount = pageMeta.likeCount || info.likeCount || "";
    info.collectCount = pageMeta.collectCount || info.collectCount || "";
    info.commentCount = pageMeta.commentCount || info.commentCount || "";
    info.shareCount = pageMeta.shareCount || info.shareCount || "";
    info.metaCapturedAt = pageMeta.capturedAt || info.metaCapturedAt;
    info.metaStatus = pageMeta.metaStatus || info.metaStatus || "";
    if (pageMeta.pageTitle) {
        info.pageTitle = pageMeta.pageTitle;
    }
    if (pageMeta.title) {
        info.title = pageMeta.title;
    } else if (info.noteTitle || info.noteDesc) {
        info.title = info.noteTitle || info.noteDesc;
    }
    if (info.site == "xiaohongshu" && shouldUsePageMetaName(info)) {
        info.originalName = info.originalName || info.name;
        info.name = buildPageMetaName(info);
    }
    return info;
}
function shouldUsePageMetaName(info) {
    if (info.site != "xiaohongshu") { return false; }
    if (shouldReplaceOpaqueName(info.name, info.ext)) { return true; }
    return Boolean(info.authorName || info.likeCount || info.collectCount || info.commentCount);
}
function shouldReplaceOpaqueName(name, ext) {
    if (!name) { return true; }
    const lowerName = name.toLowerCase();
    if (ext && lowerName.endsWith("." + ext.toLowerCase())) {
        name = name.slice(0, -(ext.length + 1));
    }
    name = name.trim();
    if (!name) { return true; }
    if (/^[0-9a-f]{16,}(_\d+)?$/i.test(name)) { return true; }
    if (/^[0-9a-z_-]{24,}$/i.test(name) && !/[\u4e00-\u9fa5]/.test(name)) { return true; }
    return false;
}
function buildPageMetaName(info) {
    const parts = [];
    if (info.authorName) {
        parts.push(info.authorName);
    }
    const text = info.noteTitle || info.noteDesc || info.title || info.noteId || "xiaohongshu";
    if (text) {
        parts.push(text);
    }
    let baseName = parts.filter(Boolean).join("_").replace(/\s+/g, " ").trim();
    if (!baseName) {
        baseName = info.noteId || "xiaohongshu";
    }
    const stats = [];
    if (info.likeCount) {
        stats.push(`赞${info.likeCount}`);
    }
    if (info.collectCount) {
        stats.push(`收藏${info.collectCount}`);
    }
    if (info.commentCount) {
        stats.push(`评${info.commentCount}`);
    }
    if (stats.length) {
        baseName += `_${stats.join("-")}`;
    }
    if (info.metaStatus == "missing" && !info.authorName && !info.noteTitle && !info.noteDesc && !info.likeCount && !info.collectCount && !info.commentCount && (!info.title || info.title == "NULL")) {
        return `【未取到页面信息】_${info.originalName || info.name || "unknown"}`;
    }
    if (baseName.length > 80) {
        baseName = baseName.slice(0, 80).trim();
    }
    return `${baseName}.${info.ext || "mp4"}`;
}
// cacheData数据 储存到 chrome.storage.local
function save(tabId) {
    clearTimeout(debounce);
    debounceTime = Date.now();
    debounceCount = 0;
    if (cacheData[tabId]) {
        // 单个标签数据超过99条 不再保存到storage
        if (cacheData[tabId]?.length <= 99) {
            (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData }, function () {
                chrome.runtime.lastError && console.log(chrome.runtime.lastError);
            });
        }
        SetIcon({ number: cacheData[tabId].length, tabId: tabId });
    }
}

/**
 * 监听 扩展 message 事件
 */
chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
    if (chrome.runtime.lastError) { return; }
    if (!G.initLocalComplete || !G.initSyncComplete) {
        sendResponse("error");
        return true;
    }
    // 以下检查是否有 tabId 不存在使用当前标签
    Message.tabId = Message.tabId ?? G.tabId;

    // 从缓存中保存数据到本地
    if (Message.Message == "pushData") {
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        sendResponse("ok");
        return true;
    }
    if (Message.Message == "updatePageMeta") {
        const tabId = sender?.tab?.id ?? Message.tabId;
        const pageMeta = Message.data;
        if (!tabId || !pageMeta || typeof pageMeta != "object") {
            sendResponse("error");
            return true;
        }
        G.pageMetaCache.set(tabId, {
            url: sender?.tab?.url || pageMeta.pageUrl || "",
            time: Date.now(),
            data: pageMeta
        });
        sendResponse({ updated: updateCachedMediaWithPageMeta(tabId, pageMeta).length });
        return true;
    }
    if (Message.Message == "clearPageMeta") {
        const tabId = sender?.tab?.id ?? Message.tabId;
        if (tabId) {
            G.pageMetaCache.delete(tabId);
        }
        sendResponse("ok");
        return true;
    }
    // 获取所有数据
    if (Message.Message == "getAllData") {
        sendResponse(cacheData);
        return true;
    }
    /**
     * 设置扩展图标数字
     * 提供 type 删除标签为 tabId 的数字
     * 不提供type 删除所有标签的数字
     */
    if (Message.Message == "ClearIcon") {
        Message.type ? SetIcon({ tabId: Message.tabId }) : SetIcon();
        sendResponse("ok");
        return true;
    }
    // 启用/禁用扩展
    if (Message.Message == "enable") {
        G.enable = !G.enable;
        chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
        sendResponse(G.enable);
        return true;
    }
    /**
     * 提供requestId数组 获取指定的数据
     */
    if (Message.Message == "getData" && Message.requestId) {
        // 判断Message.requestId是否数组
        if (!Array.isArray(Message.requestId)) {
            Message.requestId = [Message.requestId];
        }
        const response = [];
        if (Message.requestId.length) {
            for (let item in cacheData) {
                for (let data of cacheData[item]) {
                    if (Message.requestId.includes(data.requestId)) {
                        response.push(data);
                    }
                }
            }
        }
        sendResponse(response.length ? response : "error");
        return true;
    }
    /**
     * 提供 tabId 获取该标签数据
     */
    if (Message.Message == "getData") {
        sendResponse(cacheData[Message.tabId]);
        return true;
    }
    /**
     * 获取各按钮状态
     * 模拟手机 自动下载 启用 以及各种脚本状态
     */
    if (Message.Message == "getButtonState") {
        let state = {
            MobileUserAgent: G.featMobileTabId.has(Message.tabId),
            AutoDown: G.featAutoDownTabId.has(Message.tabId),
            enable: G.enable,
        }
        G.scriptList.forEach(function (item, key) {
            state[item.key] = item.tabId.has(Message.tabId);
        });
        sendResponse(state);
        return true;
    }
    // 对tabId的标签 进行模拟手机操作
    if (Message.Message == "mobileUserAgent") {
        mobileUserAgent(Message.tabId, !G.featMobileTabId.has(Message.tabId));
        chrome.tabs.reload(Message.tabId, { bypassCache: true });
        sendResponse("ok");
        return true;
    }
    // 对tabId的标签 开启 关闭 自动下载
    if (Message.Message == "autoDown") {
        if (G.featAutoDownTabId.has(Message.tabId)) {
            G.featAutoDownTabId.delete(Message.tabId);
        } else {
            G.featAutoDownTabId.add(Message.tabId);
        }
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
        sendResponse("ok");
        return true;
    }
    // 对tabId的标签 脚本注入或删除
    if (Message.Message == "script") {
        if (G.damn && G.damnUrlSet.has(Message.tabId)) {
            return;
        }
        if (!G.scriptList.has(Message.script)) {
            sendResponse("error no exists");
            return false;
        }
        const script = G.scriptList.get(Message.script);
        const scriptTabid = script.tabId;
        const refresh = Message.refresh ?? script.refresh;
        if (scriptTabid.has(Message.tabId)) {
            scriptTabid.delete(Message.tabId);
            if (Message.script == "search.js") {
                G.deepSearchTemporarilyClose = Message.tabId;
            }
            refresh && chrome.tabs.reload(Message.tabId, { bypassCache: true });
            sendResponse("ok");
            return true;
        }
        scriptTabid.add(Message.tabId);
        if (refresh) {
            chrome.tabs.reload(Message.tabId, { bypassCache: true });
        } else {
            const files = [`catch-script/${Message.script}`];
            script.i18n && files.unshift("catch-script/i18n.js");
            chrome.scripting.executeScript({
                target: { tabId: Message.tabId, allFrames: script.allFrames },
                files: files,
                injectImmediately: true,
                world: script.world
            });
        }
        sendResponse("ok");
        return true;
    }
    // 脚本注入 脚本申请多语言文件
    if (Message.Message == "scriptI18n") {
        chrome.scripting.executeScript({
            target: { tabId: Message.tabId, allFrames: true },
            files: ["catch-script/i18n.js"],
            injectImmediately: true,
            world: "MAIN"
        });
        sendResponse("ok");
        return true;
    }
    // Heart Beat
    if (Message.Message == "HeartBeat") {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0] && tabs[0].id) {
                G.tabId = tabs[0].id;
            }
        });
        sendResponse("HeartBeat OK");
        return true;
    }
    // 清理数据
    if (Message.Message == "clearData") {
        // 当前标签
        if (Message.type) {
            delete cacheData[Message.tabId];
            (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
            clearRedundant();
            sendResponse("OK");
            return true;
        }
        // 其他标签
        for (let item in cacheData) {
            if (item == Message.tabId) { continue; }
            delete cacheData[item];
        }
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant();
        sendResponse("OK");
        return true;
    }
    // 清理冗余数据
    if (Message.Message == "clearRedundant") {
        clearRedundant();
        sendResponse("OK");
        return true;
    }
    // 从 content-script 或 catch-script 传来的媒体url
    if (Message.Message == "addMedia") {
        chrome.tabs.query({}, function (tabs) {
            for (let item of tabs) {
                if (item.url == Message.href) {
                    findMedia({ url: Message.url, tabId: item.id, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, requestHeaders: Message.requestHeaders }, true, true);
                    return true;
                }
            }
            findMedia({ url: Message.url, tabId: -1, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, initiator: Message.href, requestHeaders: Message.requestHeaders }, true, true);
        });
        sendResponse("ok");
        return true;
    }
    // ffmpeg网页通信
    if (Message.Message == "catCatchFFmpeg") {
        const data = { ...Message, Message: "ffmpeg", tabId: Message.tabId ?? sender.tab.id, version: G.ffmpegConfig.version };
        chrome.tabs.query({ url: G.ffmpegConfig.url + "*" }, function (tabs) {
            if (chrome.runtime.lastError || !tabs.length) {
                chrome.tabs.create({ url: G.ffmpegConfig.url, active: Message.active ?? true }, function (tab) {
                    if (chrome.runtime.lastError) { return; }
                    G.ffmpegConfig.tab = tab.id;
                    G.ffmpegConfig.cacheData.push(data);
                });
                return true;
            }
            if (tabs[0].status == "complete") {
                chrome.tabs.sendMessage(tabs[0].id, data);
            } else {
                G.ffmpegConfig.tab = tabs[0].id;
                G.ffmpegConfig.cacheData.push(data);
            }
        });
        sendResponse("ok");
        return true;
    }
    // 发送数据到本地
    if (Message.Message == "send2local" && G.send2local) {
        try { send2local(Message.action, Message.data, Message.tabId); } catch (e) { console.log(e); }
        sendResponse("ok");
        return true;
    }
    if (Message.Message == "damnUrlHas") {
        sendResponse(G.damnUrlSet.has(Message.tabId));
        return true;
    }
});

// 选定标签 更新G.tabId
// chrome.tabs.onHighlighted.addListener(function (activeInfo) {
//     if (activeInfo.windowId == -1 || !activeInfo.tabIds || !activeInfo.tabIds.length) { return; }
//     G.tabId = activeInfo.tabIds[0];
// });

/**
 * 监听 切换标签
 * 更新全局变量 G.tabId 为当前标签
 */
chrome.tabs.onActivated.addListener(function (activeInfo) {
    G.tabId = activeInfo.tabId;
    if (cacheData[G.tabId] !== undefined) {
        SetIcon({ number: cacheData[G.tabId].length, tabId: G.tabId });
        return;
    }
    SetIcon({ tabId: G.tabId });
});

// 切换窗口，更新全局变量G.tabId
chrome.windows.onFocusChanged.addListener(function (activeInfo) {
    if (activeInfo == -1) { return; }
    chrome.tabs.query({ active: true, windowId: activeInfo }, function (tabs) {
        if (tabs[0] && tabs[0].id) {
            G.tabId = tabs[0].id;
        } else {
            G.tabId = -1;
        }
    });
}, { filters: ["normal"] });

/**
 * 监听 标签页面更新
 * 检查 清理数据
 * 检查 是否在屏蔽列表中
 */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (isSpecialPage(tab.url) || tabId <= 0 || !G.initSyncComplete) { return; }
    // console.log('onUpdated', tabId, changeInfo, tab);
    if (changeInfo.status && changeInfo.status == "loading" && G.autoClearMode == 2) {
        G.urlMap.delete(tabId);
        G.pageMetaCache.delete(tabId);
        chrome.alarms.get("save", function (alarm) {
            if (!alarm) {
                delete cacheData[tabId];
                SetIcon({ tabId: tabId });
                chrome.alarms.create("save", { when: Date.now() + 1000 });
            }
        });
    }
    // 检查当前标签是否在屏蔽列表中
    if (changeInfo.url && tabId > 0) {
        G.pageMetaCache.delete(tabId);
        if (G.blockUrl.length) {
            G.blockUrlSet.delete(tabId);
            if (isLockUrl(changeInfo.url)) {
                G.blockUrlSet.add(tabId);
            }
        }

        G.damnUrlSet.delete(tabId);
        if (isDamnUrl(changeInfo.url)) {
            G.damnUrlSet.add(tabId);
        }
    }
    chrome.sidePanel.setOptions({
        tabId,
        path: "popup.html?tabId=" + tabId
    });
});

/**
 * 监听 frame 正在载入
 * 检查 是否在屏蔽列表中 (frameId == 0 为主框架)
 * 检查 自动清理 (frameId == 0 为主框架)
 * 检查 注入脚本
 */
chrome.webNavigation.onCommitted.addListener(function (details) {
    if (isSpecialPage(details.url) || details.tabId <= 0 || !G.initSyncComplete) { return; }
    // console.log('onCommitted', details);

    // 刷新页面 检查是否在屏蔽列表中
    if (details.frameId == 0) {
        G.pageMetaCache.delete(details.tabId);
        G.blockUrlSet.delete(details.tabId);
        if (isLockUrl(details.url)) {
            G.blockUrlSet.add(details.tabId);
        }

        G.damnUrlSet.delete(details.tabId);
        if (isDamnUrl(details.url)) {
            G.damnUrlSet.add(details.tabId);
        }
    }

    // 刷新清理角标数
    if (details.frameId == 0 && (!['auto_subframe', 'manual_subframe', 'form_submit'].includes(details.transitionType)) && G.autoClearMode == 1) {
        delete cacheData[details.tabId];
        G.urlMap.delete(details.tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        SetIcon({ tabId: details.tabId });
    }

    // chrome内核版本 102 以下不支持 chrome.scripting.executeScript API
    if (G.version < 102) { return; }

    if (G.deepSearch && G.deepSearchTemporarilyClose != details.tabId) {
        G.scriptList.get("search.js").tabId.add(details.tabId);
        G.deepSearchTemporarilyClose = null;
    }

    // catch-script 脚本
    G.scriptList.forEach(function (item, script) {
        if (!item.tabId.has(details.tabId) || !item.allFrames) { return true; }

        const files = [`catch-script/${script}`];
        item.i18n && files.unshift("catch-script/i18n.js");
        chrome.scripting.executeScript({
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            files: files,
            injectImmediately: true,
            world: item.world
        });
    });

    // 模拟手机
    if (G.initLocalComplete && G.featMobileTabId.size > 0 && G.featMobileTabId.has(details.tabId)) {
        chrome.scripting.executeScript({
            args: [G.MobileUserAgent.toString()],
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            func: function () {
                Object.defineProperty(navigator, 'userAgent', { value: arguments[0], writable: false });
            },
            injectImmediately: true,
            world: "MAIN"
        });
    }
});

/**
 * 监听 标签关闭 清理数据
 */
chrome.tabs.onRemoved.addListener(function (tabId) {
    // 清理缓存数据
    chrome.alarms.get("nowClear", function (alarm) {
        !alarm && chrome.alarms.create("nowClear", { when: Date.now() + 1000 });
    });
    G.pageMetaCache.delete(tabId);
    if (G.initSyncComplete) {
        G.blockUrlSet.has(tabId) && G.blockUrlSet.delete(tabId);
        G.damnUrlSet.has(tabId) && G.damnUrlSet.delete(tabId);
    }
});

/**
 * 浏览器 扩展快捷键
 */
chrome.commands.onCommand.addListener(function (command) {
    if (command == "auto_down") {
        if (G.featAutoDownTabId.has(G.tabId)) {
            G.featAutoDownTabId.delete(G.tabId);
        } else {
            G.featAutoDownTabId.add(G.tabId);
        }
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
    } else if (command == "catch") {
        const scriptTabid = G.scriptList.get("catch.js").tabId;
        scriptTabid.has(G.tabId) ? scriptTabid.delete(G.tabId) : scriptTabid.add(G.tabId);
        chrome.tabs.reload(G.tabId, { bypassCache: true });
    } else if (command == "m3u8") {
        chrome.tabs.create({ url: "m3u8.html" });
    } else if (command == "clear") {
        delete cacheData[G.tabId];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant();
        SetIcon({ tabId: G.tabId });
    } else if (command == "enable") {
        G.enable = !G.enable;
        chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
    } else if (command == "reboot") {
        chrome.runtime.reload();
    } else if (command == "deepSearch") {
        const script = G.scriptList.get("search.js");
        const scriptTabid = script.tabId;
        if (scriptTabid.has(G.tabId)) {
            scriptTabid.delete(G.tabId);
            G.deepSearchTemporarilyClose = G.tabId;
            chrome.tabs.reload(G.tabId, { bypassCache: true });
            return;
        }
        scriptTabid.add(G.tabId);
        chrome.tabs.reload(G.tabId, { bypassCache: true });
    }
});

/**
 * 监听 页面完全加载完成 判断是否在线ffmpeg页面
 * 如果是在线ffmpeg 则发送数据
 */
chrome.webNavigation.onCompleted.addListener(function (details) {
    if (G.ffmpegConfig.tab && details.tabId == G.ffmpegConfig.tab) {
        setTimeout(() => {
            G.ffmpegConfig.cacheData.forEach(data => {
                chrome.tabs.sendMessage(details.tabId, data);
            });
            G.ffmpegConfig.cacheData = [];
            G.ffmpegConfig.tab = 0;
        }, 500);
    }
});

// 操作符检查
function operatorCheck(size, Obj) {
    const unitNumber = {
        "B": 1,
        "BYTE": 1,
        "KB": 1024,
        "MB": 1048576,
        "GB": 1073741824
    };
    const unit = (Obj.unit || "B");
    const targetSize = Obj.size * (unitNumber[unit] || 1);
    switch (Obj.operator) {
        case "=":
            return size == targetSize;
        case "<":
            return size < targetSize;
        case ">":
            return size > targetSize;
        case "<=":
            return size <= targetSize;
        case ">=":
            return size >= targetSize;
        case "!=":
            return size != targetSize;
        case "~":
            return (Obj.min ? size >= Obj.min * (unitNumber[unit] || 1) : true) && (Obj.max ? size <= Obj.max * (unitNumber[unit] || 1) : true);
        default:
            return size <= targetSize;
    }
}

/**
 * 检查扩展名和大小
 * @param {String} ext 
 * @param {Number} size 
 * @returns {Boolean|String}
 */
function CheckExtension(ext, size) {
    const Ext = G.Ext.get(ext);
    if (!Ext) { return false; }
    if (!Ext.state) { return "break"; }
    if (Ext.size != 0 && size != undefined && !operatorCheck(size, Ext)) {
        return "break";
    }
    return true;
}

/**
 * 检查类型和大小
 * @param {String} dataType 
 * @param {Number} dataSize 
 * @returns {Boolean|String}
 */
function CheckType(dataType, dataSize) {
    const typeInfo = G.Type.get(dataType.split("/")[0] + "/*") || G.Type.get(dataType);
    if (!typeInfo) { return false; }
    if (!typeInfo.state) { return "break"; }
    if (typeInfo.size != 0 && dataSize != undefined && !operatorCheck(dataSize, typeInfo)) {
        return "break";
    }
    return true;
}

/**
 * 获取文件名及扩展名
 * @param {String} pathname 
 * @returns {Array}
 */
function fileNameParse(pathname) {
    let fileName = decodeURI(pathname.split("/").pop());
    let ext = fileName.split(".");
    ext = ext.length == 1 ? undefined : ext.pop().toLowerCase();
    return [fileName, ext ? ext : undefined];
}

/**
 * 获取响应头信息
 * @param {Object} data 
 * @returns {Object}
 */
function getResponseHeadersValue(data) {
    const header = {};
    if (data.responseHeaders == undefined || data.responseHeaders.length == 0) { return header; }
    for (let item of data.responseHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "content-length") {
            header.size ??= parseInt(item.value);
        } else if (item.name == "content-type") {
            header.type = item.value.split(";")[0].toLowerCase();
        } else if (item.name == "content-disposition") {
            header.attachment = item.value;
        } else if (item.name == "content-range") {
            let size = item.value.split('/')[1];
            if (size !== '*') {
                header.size = parseInt(size);
            }
        }
    }
    return header;
}

/**
 * 获取请求头
 * @param {Object} data 
 * @returns {Object|Boolean}
 */
function getRequestHeaders(data) {
    if (data.allRequestHeaders == undefined || data.allRequestHeaders.length == 0) { return false; }
    const header = {};
    for (let item of data.allRequestHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "referer") {
            header.referer = item.value;
        } else if (item.name == "origin") {
            header.origin = item.value;
        } else if (item.name == "cookie") {
            header.cookie = item.value;
        } else if (item.name == "authorization") {
            header.authorization = item.value;
        }
    }
    if (Object.keys(header).length) {
        return header;
    }
    return false;
}
//设置扩展图标
function SetIcon(obj) {
    if (obj?.number == 0 || obj?.number == undefined) {
        chrome.action.setBadgeText({ text: "", tabId: obj?.tabId ?? G.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "还没闻到味儿~", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    } else if (G.badgeNumber) {
        obj.number = obj.number > 999 ? "999+" : obj.number.toString();
        chrome.action.setBadgeText({ text: obj.number, tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "抓到 " + obj.number + " 条鱼", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    }
}

// 模拟手机端
function mobileUserAgent(tabId, change = false) {
    if (change) {
        G.featMobileTabId.add(tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [tabId],
            addRules: [{
                "id": tabId,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [{
                        "header": "User-Agent",
                        "operation": "set",
                        "value": G.MobileUserAgent
                    }]
                },
                "condition": {
                    "tabIds": [tabId],
                    "resourceTypes": Object.values(chrome.declarativeNetRequest.ResourceType)
                }
            }]
        });
        return true;
    }
    G.featMobileTabId.delete(tabId) && (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [tabId]
    });
}

// 判断特殊页面
function isSpecialPage(url) {
    if (!url || url == "null") { return true; }
    return !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:"));
}

// 测试
// chrome.storage.local.get(function (data) { console.log(data.MediaData) });
// chrome.declarativeNetRequest.getSessionRules(function (rules) { console.log(rules); });
// chrome.tabs.query({}, function (tabs) { for (let item of tabs) { console.log(item.id); } });
