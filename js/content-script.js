(function () {
    var _videoObj = [];
    var _videoSrc = [];
    var _key = new Set();
    const XHS_HOST_RE = /(^|\.)xiaohongshu\.com$/i;
    let xhsMetaReportTimer = null;
    let xhsMetaObserverStarted = false;
    let xhsLastMetaSignature = "";

    function normalizeText(text) {
        return typeof text == "string" ? text.replace(/\s+/g, " ").trim() : "";
    }
    function firstText(selectors, root = document) {
        for (const selector of selectors) {
            try {
                const dom = root.querySelector(selector);
                const text = normalizeText(dom?.innerText || dom?.textContent || "");
                if (text) { return text; }
            } catch (e) { }
        }
        return "";
    }
    function firstMeta(selectors) {
        for (const selector of selectors) {
            try {
                const dom = document.querySelector(selector);
                const text = normalizeText(dom?.getAttribute("content") || "");
                if (text) { return text; }
            } catch (e) { }
        }
        return "";
    }
    function parseCountText(text) {
        text = normalizeText(text);
        if (!text) { return ""; }
        const match = text.match(/([\d.,]+(?:\s*[万wW])?)/);
        return match ? match[1].replace(/\s+/g, "") : text;
    }
    function firstCount(selectors, root = document) {
        for (const selector of selectors) {
            try {
                const dom = root.querySelector(selector);
                const text = parseCountText(dom?.innerText || dom?.textContent || "");
                if (text) { return text; }
            } catch (e) { }
        }
        return "";
    }
    function getLocationInfo() {
        const url = new URL(location.href);
        const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/i);
        return {
            href: url.href,
            pathname: url.pathname,
            noteId: url.searchParams.get("noteId") || url.searchParams.get("itemId") || (match ? match[1] : "")
        };
    }
    function parseInitialState() {
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
            const text = script.textContent || "";
            if (!text.includes("__INITIAL_STATE__")) { continue; }
            const match = text.match(/window\.__INITIAL_STATE__\s*=\s*/);
            if (!match || match.index == null) { continue; }
            const startIndex = match.index + match[0].length;
            const stateText = extractScriptExpression(text, startIndex);
            if (!stateText) { continue; }
            const parsedState = parseScriptObject(stateText);
            if (parsedState) { return parsedState; }
        }
        return null;
    }
    function extractScriptExpression(text, startIndex) {
        let index = startIndex;
        while (index < text.length && /\s/.test(text[index])) {
            index++;
        }
        if (index >= text.length) { return ""; }
        const startChar = text[index];
        const pairs = {
            "{": "}",
            "[": "]",
            "(": ")"
        };
        const endChar = pairs[startChar];
        if (!endChar) {
            const semicolonIndex = text.indexOf(";", index);
            return (semicolonIndex == -1 ? text.slice(index) : text.slice(index, semicolonIndex)).trim();
        }

        let depth = 0;
        let quote = "";
        let escaped = false;
        for (let i = index; i < text.length; i++) {
            const char = text[i];
            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char == "\\") {
                    escaped = true;
                    continue;
                }
                if (char == quote) {
                    quote = "";
                }
                continue;
            }
            if (char == "'" || char == '"' || char == "`") {
                quote = char;
                continue;
            }
            if (char == startChar) {
                depth++;
                continue;
            }
            if (char == endChar) {
                depth--;
                if (depth == 0) {
                    return text.slice(index, i + 1).trim();
                }
            }
        }
        return text.slice(index).trim();
    }
    function parseScriptObject(text) {
        if (!text) { return null; }
        let source = text.trim();
        if (source.endsWith(";")) {
            source = source.slice(0, -1).trim();
        }
        source = source.replace(/\\u002F/g, "/");
        try {
            return JSON.parse(source);
        } catch (e) { }
        try {
            return Function(`"use strict"; return (${source});`)();
        } catch (e) { }
        return null;
    }
    function parseJsonLd() {
        const result = {};
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        scripts.forEach(function (script) {
            const parsed = parseScriptObject(script.textContent || "");
            if (!parsed) { return; }
            walkObject(parsed, function (node) {
                if (!node || typeof node != "object") { return; }
                if (!result.authorName && typeof node.name == "string" && (node["@type"] == "Person" || node["@type"] == "Organization")) {
                    result.authorName = normalizeText(node.name);
                }
                if (!result.authorName && node.author && typeof node.author == "object") {
                    result.authorName = normalizeText(node.author.name || "");
                }
                if (!node.interactionStatistic) { return; }
                const stats = Array.isArray(node.interactionStatistic) ? node.interactionStatistic : [node.interactionStatistic];
                stats.forEach(function (item) {
                    const interactionType = normalizeText(item?.interactionType?.["@type"] || item?.interactionType || "").toLowerCase();
                    const count = normalizeText(String(item?.userInteractionCount ?? item?.count ?? ""));
                    if (!count) { return; }
                    if (!result.likeCount && interactionType.includes("like")) {
                        result.likeCount = count;
                    } else if (!result.commentCount && interactionType.includes("comment")) {
                        result.commentCount = count;
                    } else if (!result.shareCount && interactionType.includes("share")) {
                        result.shareCount = count;
                    }
                });
            });
        });
        return result;
    }
    function walkObject(node, visitor, depth = 0) {
        if (!node || typeof node != "object" || depth > 10) { return; }
        visitor(node);
        if (Array.isArray(node)) {
            node.forEach(item => walkObject(item, visitor, depth + 1));
            return;
        }
        Object.keys(node).forEach(key => walkObject(node[key], visitor, depth + 1));
    }
    function buildXhsMetaFromState(state, noteId) {
        if (!state || typeof state != "object") { return null; }
        const candidates = [];
        walkObject(state, function (node) {
            if (!node || typeof node != "object") { return; }
            const interactInfo = node.interactInfo || node.interactionInfo || node.engageInfo;
            const user = node.user || node.author || node.userInfo;
            const hasText = typeof node.title == "string" || typeof node.desc == "string";
            if (!interactInfo && !hasText && !user) { return; }
            let score = 0;
            if (interactInfo) { score += 3; }
            if (hasText) { score += 2; }
            if (user) { score += 1; }
            if (noteId && (node.noteId == noteId || node.id == noteId || node.note_id == noteId)) {
                score += 5;
            }
            candidates.push({ node, score });
        });
        if (!candidates.length) { return null; }
        candidates.sort((a, b) => b.score - a.score);
        const note = candidates[0].node;
        const interactInfo = note.interactInfo || note.interactionInfo || note.engageInfo || {};
        const user = note.user || note.author || note.userInfo || {};
        return {
            noteId: note.noteId || note.id || note.note_id || noteId || "",
            noteTitle: normalizeText(note.title || ""),
            noteDesc: normalizeText(note.desc || note.content || ""),
            authorName: normalizeText(user.nickname || user.name || user.nickName || ""),
            likeCount: normalizeText(String(interactInfo.likedCount ?? interactInfo.likeCount ?? "")),
            collectCount: normalizeText(String(interactInfo.collectedCount ?? interactInfo.collectCount ?? "")),
            commentCount: normalizeText(String(interactInfo.commentCount ?? "")),
            shareCount: normalizeText(String(interactInfo.shareCount ?? "")),
        };
    }
    function getXiaohongshuPageMeta() {
        const locationInfo = getLocationInfo();
        // 弹窗笔记详情容器优先，避免取到列表页其他笔记卡片的信息
        const noteContainer = document.querySelector(".noteContainer, #noteContainer");
        const detailRoot = noteContainer || document.querySelector(".note-scroller, .note-content") || document;
        const authorRoot = detailRoot.querySelector(".author-container, .author-wrapper") || detailRoot;
        const statsRoot = detailRoot.querySelector(".interactions.engage-bar .buttons.engage-bar-style, .interactions.engage-bar, .engage-bar-container .buttons, .engage-bar-container") || detailRoot;
        const domMeta = {
            noteId: locationInfo.noteId,
            noteTitle: firstText([
                "#detail-title",
                ".note-scroller #detail-title",
                ".note-content .title",
                ".title"
            ], detailRoot),
            noteDesc: firstText([
                "#detail-desc",
                ".note-scroller #detail-desc",
                ".desc",
                ".note-content .desc"
            ], detailRoot),
            authorName: firstText([
                ".author-wrapper .username",
                ".author-wrapper .name .username",
                ".author-wrapper .name",
                ".user-info .name",
                ".author-wrapper .author-name",
                ".author-container .name",
                ".username",
                "[class*='author'] [class*='name']",
                "[class*='author'] [class*='user']",
                "[class*='user'] [class*='name']"
            ], authorRoot) || firstText([
                ".author-wrapper .username",
                ".author-wrapper .name .username",
                ".author-wrapper .name",
                ".user-info .name",
                ".author-wrapper .author-name",
                ".author-container .name",
                ".username",
                "[class*='author'] [class*='name']",
                "[class*='author'] [class*='user']",
                "[class*='user'] [class*='name']"
            ], detailRoot),
            likeCount: firstCount([
                ".left .like-wrapper .count",
                ".like-wrapper > .count",
                ".like-wrapper .count",
                ".like-wrapper",
                "[class*='like-wrapper']",
                "button[class*='like']"
            ], statsRoot) || firstCount([
                ".left .like-wrapper .count",
                ".like-wrapper > .count",
                ".like-wrapper .count",
                ".like-wrapper",
                "[class*='like-wrapper']",
                "button[class*='like']"
            ], detailRoot),
            collectCount: firstCount([
                ".left .collect-wrapper .count",
                ".collect-wrapper > .count",
                ".collect-wrapper .count",
                ".collect-wrapper",
                "[class*='collect-wrapper']",
                "button[class*='collect']"
            ], statsRoot) || firstCount([
                ".left .collect-wrapper .count",
                ".collect-wrapper > .count",
                ".collect-wrapper .count",
                ".collect-wrapper",
                "[class*='collect-wrapper']",
                "button[class*='collect']"
            ], detailRoot),
            commentCount: firstCount([
                ".left .chat-wrapper .count",
                ".chat-wrapper > .count",
                ".chat-wrapper .count",
                ".comments-el .total",
                ".chat-wrapper",
                "[class*='comment-wrapper']",
                "[class*='chat-wrapper']",
                "button[class*='comment']"
            ], statsRoot) || firstCount([
                ".left .chat-wrapper .count",
                ".chat-wrapper > .count",
                ".chat-wrapper .count",
                ".comments-el .total",
                ".chat-wrapper",
                "[class*='comment-wrapper']",
                "[class*='chat-wrapper']",
                "button[class*='comment']"
            ], detailRoot),
            shareCount: firstCount([
                ".share-wrapper .count",
                "[class*='share'] .count",
                ".share-wrapper",
                "[class*='share-wrapper']",
                "button[class*='share']"
            ], statsRoot) || firstCount([
                ".share-wrapper .count",
                "[class*='share'] .count",
                ".share-wrapper",
                "[class*='share-wrapper']",
                "button[class*='share']"
            ], detailRoot)
        };
        const stateMeta = buildXhsMetaFromState(parseInitialState(), locationInfo.noteId) || {};
        const jsonLdMeta = parseJsonLd();
        const noteDesc = domMeta.noteDesc || stateMeta.noteDesc || firstMeta([
            'meta[name="description"]',
            'meta[property="og:description"]'
        ]);
        const noteTitle = domMeta.noteTitle || stateMeta.noteTitle || firstMeta([
            'meta[property="og:title"]',
            'meta[name="og:title"]'
        ]) || noteDesc.slice(0, 60);
        const title = noteTitle || noteDesc || normalizeText(document.title);
        return {
            site: "xiaohongshu",
            pageTitle: normalizeText(document.title),
            title: title,
            noteTitle: noteTitle,
            noteDesc: noteDesc,
            authorName: domMeta.authorName || stateMeta.authorName || jsonLdMeta.authorName || "",
            likeCount: domMeta.likeCount || stateMeta.likeCount || jsonLdMeta.likeCount || "",
            collectCount: domMeta.collectCount || stateMeta.collectCount || "",
            commentCount: domMeta.commentCount || stateMeta.commentCount || jsonLdMeta.commentCount || "",
            shareCount: domMeta.shareCount || stateMeta.shareCount || jsonLdMeta.shareCount || "",
            noteId: domMeta.noteId || stateMeta.noteId || "",
            pageUrl: locationInfo.href,
            pagePath: locationInfo.pathname,
            extractor: [
                domMeta.noteTitle || domMeta.noteDesc || domMeta.authorName ? "dom" : "",
                stateMeta.noteTitle || stateMeta.noteDesc || stateMeta.authorName || stateMeta.likeCount || stateMeta.collectCount || stateMeta.commentCount ? "initial_state" : "",
                jsonLdMeta.authorName || jsonLdMeta.likeCount || jsonLdMeta.commentCount || jsonLdMeta.shareCount ? "json_ld" : ""
            ].filter(Boolean).join("+") || "fallback",
            capturedAt: Date.now()
        };
    }
    function getPageMeta() {
        const hostname = location.hostname || "";
        if (XHS_HOST_RE.test(hostname)) {
            return getXiaohongshuPageMeta();
        }
        return {
            site: hostname,
            pageTitle: normalizeText(document.title),
            title: normalizeText(document.title),
            pageUrl: location.href,
            pagePath: location.pathname,
            capturedAt: Date.now(),
            extractor: "default"
        };
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
    function getPageMetaSignature(pageMeta) {
        return [
            pageMeta?.pagePath || "",
            pageMeta?.noteId || "",
            pageMeta?.noteTitle || "",
            pageMeta?.noteDesc || "",
            pageMeta?.authorName || "",
            pageMeta?.likeCount || "",
            pageMeta?.collectCount || "",
            pageMeta?.commentCount || "",
            pageMeta?.shareCount || ""
        ].join("::");
    }
    function reportPageMeta(force = false) {
        if (!XHS_HOST_RE.test(location.hostname || "")) { return false; }
        const pageMeta = getXiaohongshuPageMeta();
        if (!hasMeaningfulPageMeta(pageMeta)) { return false; }
        const signature = getPageMetaSignature(pageMeta);
        if (!force && signature == xhsLastMetaSignature) {
            return false;
        }
        xhsLastMetaSignature = signature;
        chrome.runtime.sendMessage({ Message: "updatePageMeta", data: pageMeta }, function () {
            void chrome.runtime.lastError;
        });
        return true;
    }
    function clearPageMetaCache() {
        if (!XHS_HOST_RE.test(location.hostname || "")) { return; }
        chrome.runtime.sendMessage({ Message: "clearPageMeta" }, function () {
            void chrome.runtime.lastError;
        });
    }
    function schedulePageMetaReport(delay = 180, force = false) {
        if (!XHS_HOST_RE.test(location.hostname || "")) { return; }
        clearTimeout(xhsMetaReportTimer);
        xhsMetaReportTimer = setTimeout(function () {
            reportPageMeta(force);
        }, delay);
    }
    function watchXiaohongshuPageMeta() {
        if (xhsMetaObserverStarted || !XHS_HOST_RE.test(location.hostname || "")) { return; }
        xhsMetaObserverStarted = true;

        const root = document.documentElement || document.body;
        if (root) {
            const observer = new MutationObserver(function () {
                schedulePageMetaReport();
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }

        const wrapHistoryMethod = function (methodName) {
            const original = history[methodName];
            if (typeof original != "function") { return; }
            history[methodName] = function () {
                const result = original.apply(this, arguments);
                clearPageMetaCache();
                xhsLastMetaSignature = "";
                schedulePageMetaReport(120, true);
                return result;
            };
        };
        wrapHistoryMethod("pushState");
        wrapHistoryMethod("replaceState");

        window.addEventListener("popstate", function () {
            clearPageMetaCache();
            xhsLastMetaSignature = "";
            schedulePageMetaReport(120, true);
        });
        window.addEventListener("hashchange", function () {
            clearPageMetaCache();
            xhsLastMetaSignature = "";
            schedulePageMetaReport(120, true);
        });
        window.addEventListener("load", function () {
            clearPageMetaCache();
            schedulePageMetaReport(120, true);
            setTimeout(function () { schedulePageMetaReport(400, true); }, 400);
        });

        clearPageMetaCache();
        schedulePageMetaReport(120, true);
        setTimeout(function () { schedulePageMetaReport(500, true); }, 500);
        setTimeout(function () { schedulePageMetaReport(1200, true); }, 1200);
    }
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (chrome.runtime.lastError) { return; }
        // 获取页面视频对象
        if (Message.Message == "getVideoState") {
            let videoObj = [];
            let videoSrc = [];
            document.querySelectorAll("video, audio").forEach(function (video) {
                if (video.currentSrc != "" && video.currentSrc != undefined) {
                    videoObj.push(video);
                    videoSrc.push(video.currentSrc);
                }
            });
            const iframe = document.querySelectorAll("iframe");
            if (iframe.length > 0) {
                iframe.forEach(function (iframe) {
                    if (iframe.contentDocument == null) { return true; }
                    iframe.contentDocument.querySelectorAll("video, audio").forEach(function (video) {
                        if (video.currentSrc != "" && video.currentSrc != undefined) {
                            videoObj.push(video);
                            videoSrc.push(video.currentSrc);
                        }
                    });
                });
            }
            if (videoObj.length > 0) {
                if (videoObj.length !== _videoObj.length || videoSrc.toString() !== _videoSrc.toString()) {
                    _videoSrc = videoSrc;
                    _videoObj = videoObj;
                }
                Message.index = Message.index == -1 ? 0 : Message.index;
                const video = videoObj[Message.index];
                const timePCT = video.currentTime / video.duration * 100;
                sendResponse({
                    time: timePCT,
                    currentTime: video.currentTime,
                    duration: video.duration,
                    volume: video.volume,
                    count: _videoObj.length,
                    src: _videoSrc,
                    paused: video.paused,
                    loop: video.loop,
                    speed: video.playbackRate,
                    muted: video.muted,
                    type: video.tagName.toLowerCase()
                });
                return true;
            }
            sendResponse({ count: 0 });
            return true;
        }
        // 速度控制
        if (Message.Message == "speed") {
            _videoObj[Message.index].playbackRate = Message.speed;
            return true;
        }
        // 画中画
        if (Message.Message == "pip") {
            if (document.pictureInPictureElement) {
                try { document.exitPictureInPicture(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            try { _videoObj[Message.index].requestPictureInPicture(); } catch (e) { return true; }
            sendResponse({ state: true });
            return true;
        }
        // 全屏
        if (Message.Message == "fullScreen") {
            if (document.fullscreenElement) {
                try { document.exitFullscreen(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            setTimeout(function () {
                try { _videoObj[Message.index].requestFullscreen(); } catch (e) { return true; }
            }, 500);
            sendResponse({ state: true });
            return true;
        }
        // 播放
        if (Message.Message == "play") {
            _videoObj[Message.index].play();
            return true;
        }
        // 暂停
        if (Message.Message == "pause") {
            _videoObj[Message.index].pause();
            return true;
        }
        // 循环播放
        if (Message.Message == "loop") {
            _videoObj[Message.index].loop = Message.action;
            return true;
        }
        // 设置音量
        if (Message.Message == "setVolume") {
            _videoObj[Message.index].volume = Message.volume;
            sendResponse("ok");
            return true;
        }
        // 静音
        if (Message.Message == "muted") {
            _videoObj[Message.index].muted = Message.action;
            return true;
        }
        // 设置视频进度
        if (Message.Message == "setTime") {
            const time = Message.time * _videoObj[Message.index].duration / 100;
            _videoObj[Message.index].currentTime = time;
            sendResponse("ok");
            return true;
        }
        // 截图视频图片
        if (Message.Message == "screenshot") {
            try {
                let video = _videoObj[Message.index];
                let canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
                let link = document.createElement("a");
                link.href = canvas.toDataURL("image/jpeg");
                link.download = `${location.hostname}-${secToTime(video.currentTime)}.jpg`;
                link.click();
                canvas = null;
                link = null;
                sendResponse("ok");
                return true;
            } catch (e) { console.log(e); return true; }
        }
        if (Message.Message == "getKey") {
            sendResponse(Array.from(_key));
            return true;
        }
        if (Message.Message == "ffmpeg") {
            if (!Message.files) {
                window.postMessage(Message);
                sendResponse("ok");
                return true;
            }
            Message.quantity ??= Message.files.length;
            for (let item of Message.files) {
                const data = { ...Message, ...item };
                data.type = item.type ?? "video";
                if (data.data instanceof Blob) {
                    window.postMessage(data);
                } else {
                    fetch(data.data)
                        .then(response => response.blob())
                        .then(blob => {
                            data.data = blob;
                            window.postMessage(data);
                        });
                }
            }
            sendResponse("ok");
            return true;
        }
        if (Message.Message == "getPage") {
            if (Message.find) {
                const DOM = document.querySelector(Message.find);
                DOM ? sendResponse(DOM.innerHTML) : sendResponse("");
                return true;
            }
            sendResponse(document.documentElement.outerHTML);
            return true;
        }
        if (Message.Message == "getPageMeta") {
            sendResponse(getPageMeta());
            return true;
        }
    });

    // Heart Beat
    var Port;
    function connect() {
        Port = chrome.runtime.connect(chrome.runtime.id, { name: "HeartBeat" });
        Port.postMessage("HeartBeat");
        Port.onMessage.addListener(function (message, Port) { return true; });
        Port.onDisconnect.addListener(connect);
    }
    connect();

    function secToTime(sec) {
        let time = "";
        let hour = Math.floor(sec / 3600);
        let min = Math.floor((sec % 3600) / 60);
        sec = Math.floor(sec % 60);
        if (hour > 0) { time = hour + "'"; }
        if (min < 10) { time += "0"; }
        time += min + "'";
        if (sec < 10) { time += "0"; }
        time += sec;
        return time;
    }
    window.addEventListener("message", (event) => {
        if (!event.data || !event.data.action) { return; }
        if (event.data.action == "catCatchAddMedia") {
            if (!event.data.url) { return; }
            chrome.runtime.sendMessage({
                Message: "addMedia",
                url: event.data.url,
                href: event.data.href ?? event.source.location.href,
                extraExt: event.data.ext,
                mime: event.data.mime,
                requestHeaders: { referer: event.data.referer },
                requestId: event.data.requestId
            });
        }
        if (event.data.action == "catCatchAddKey") {
            let key = event.data.key;
            if (key instanceof ArrayBuffer || key instanceof Array) {
                key = ArrayToBase64(key);
            }
            if (_key.has(key)) { return; }
            _key.add(key);
            chrome.runtime.sendMessage({
                Message: "send2local",
                action: "addKey",
                data: key,
            });
            chrome.runtime.sendMessage({
                Message: "popupAddKey",
                data: key,
                url: event.data.url,
            });
        }
        if (event.data.action == "catCatchFFmpeg") {
            if (!event.data.use ||
                !event.data.files ||
                !event.data.files instanceof Array ||
                event.data.files.length == 0
            ) { return; }
            event.data.title = event.data.title ?? document.title ?? new Date().getTime().toString();
            event.data.title = event.data.title.replaceAll('"', "").replaceAll("'", "").replaceAll(" ", "");
            let data = {
                Message: event.data.action,
                action: event.data.use,
                files: event.data.files,
                url: event.data.href ?? event.source.location.href,
            };
            data = { ...event.data, ...data };
            chrome.runtime.sendMessage(data);
        }
        if (event.data.action == "catCatchFFmpegResult") {
            if (!event.data.state || !event.data.tabId) { return; }
            chrome.runtime.sendMessage({ Message: "catCatchFFmpegResult", ...event.data });
        }
        if (event.data.action == "catCatchToBackground") {
            delete event.data.action;
            chrome.runtime.sendMessage(event.data);
        }
        // if (event.data.action == "catCatchDashDRMMedia") {
        //     // TODO DRM Media
        //     console.log("DRM Media", event);
        // }
    }, false);

    function ArrayToBase64(data) {
        try {
            let bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            if (typeof _btoa == "function") {
                return _btoa(binary);
            }
            return btoa(binary);
        } catch (e) {
            return false;
        }
    }
    watchXiaohongshuPageMeta();
})();
