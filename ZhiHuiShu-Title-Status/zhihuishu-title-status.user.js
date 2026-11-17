// ==UserScript==
// @name         智慧树 - 标题状态显示器
// @namespace    https://github.com/LumiCorn/Browser-Scripts
// @version      1.3.0
// @description  纯执行脚本，无 UI。把智慧树各页面的标签页标题改成「当前位置 - 用户名」，例如「首页 - 李侠」「问答 - 李侠」「作业 - 李侠」，方便多标签时快速辨认当前在哪。
// @author       LumiCornX
// @match        *://*.zhihuishu.com/*
// @run-at       document-start
// @downloadURL  https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-Title-Status/zhihuishu-title-status.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-Title-Status/zhihuishu-title-status.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @license      MIT
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     *  设计说明
     *
     *  纯执行脚本：不创建任何 DOM、不注入样式、不加悬浮面板。
     *  唯一副作用是改写 document.title。
     *
     *  标题格式：状态 - 用户名；读不到用户名时只写状态。
     *     首页              → 首页 - 李侠
     *     问答（列表/详情）  → 问答 - 李侠
     *     见面课            → 见面课 - 李侠
     *     作业考试/作业结果  → 作业 - 李侠
     *     直播              → 直播 - 李侠
     *     官网              → 官网 - 李侠
     *     未登录             → 官网（只有状态）
     *     无法识别           → 保持页面原始标题
     *
     *  为什么不显示课程名：页面里本来就有课程名，标题重复没意义；
     *  而且首页是课程轮播墙，同一时刻多门课都在屏幕上，没有唯一的
     *  “当前课程”，强行取会取错。
     * ================================================================ */

    const SCRIPT_VERSION = '1.3.0';

    // 用户名跨子域不共享 document.cookie，所以缓存到 GM 存储
    const NAME_CACHE_KEY = 'zhs_title_userName';

    // 已识别的用户名选择器（按优先级）
    // onlineweb 首页：<span class="user-logo_name">李侠</span>
    //
    // 注意：不要加宽泛的 .user-name！
    // qah5 问答页的 .user-name 是「课程问答小助手」（智慧树官方服务助教账号），
    // 不是当前登录用户；把它当用户名会显示错人。
    const NAME_SELECTORS = [
        '.user-logo_name',
        '.header-user-name',
        '.cns-menu-wrapper .user-name',
        '.user-info .user-name',
    ];

    // 助教/官方账号等非本人名称，命中即视为无效
    const BAD_NAME_PATTERNS = [
        /小助手/,
        /官方/,
        /助教/,
        /^(登录|注册|未登录|客服|帮助中心|消息|身份切换)$/,
        /undefined|null/i,
    ];

    /* ================================================================
     *  GM 兼容层（Tampermonkey / ScriptCat / Violentmonkey）
     * ================================================================ */

    const GMs = (() => {
        // 注意：不能用 new Map()。
        // lc.zhihuishu.com（直播页）上有老代码把全局 Map 覆盖成了
        // 只有 put() 的自定义实现，new Map().has 会是 undefined，
        // 直接用 Map 会在那个域上抛 TypeError 导致整个脚本不执行。
        const memKeys = [];
        const memVals = [];
        const memGet = (k) => {
            for (let i = 0; i < memKeys.length; i += 1) {
                if (memKeys[i] === k) return memVals[i];
            }
            return undefined;
        };
        const memSet = (k, v) => {
            for (let i = 0; i < memKeys.length; i += 1) {
                if (memKeys[i] === k) { memVals[i] = v; return; }
            }
            memKeys.push(k);
            memVals.push(v);
        };
        const call = (fnNames, ...args) => {
            for (const n of fnNames) {
                try {
                    const fn = typeof globalThis[n] === 'function' ? globalThis[n] : null;
                    if (fn) {
                        const r = fn.apply(null, args);
                        if (r !== undefined) return r;
                    }
                } catch (e) { /* 继续尝试下一个 */ }
            }
            return undefined;
        };
        return {
            set: (k, v) => {
                memSet(k, v);
                call(['GM_setValue'], k, v);
            },
            get: (k, d) => {
                const remote = call(['GM_getValue'], k, undefined);
                if (remote !== undefined) return remote;
                const local = memGet(k);
                return local === undefined ? d : local;
            },
            menu: (label, fn) => call(['GM_registerMenuCommand'], label, fn),
        };
    })();

    /* ================================================================
     *  用户名提取
     * ================================================================ */

    let cachedName = GMs.get(NAME_CACHE_KEY, '') || '';

    function isBadName(text) {
        if (!text) return true;
        if (text.length > 20) return true;
        return BAD_NAME_PATTERNS.some((re) => re.test(text));
    }

    function readNameFromCookie() {
        // CASLOGC 是智慧树 CAS 登录票据，域为 .zhihuishu.com → 所有子域可读。
        // 内容为 URL 编码的 JSON：{"realName":"李侠","userId":...,"uuid":"...","username":"..."}
        // realName 才是真实姓名，username 是一串哈希，不要用错。
        try {
            const raw = document.cookie
                .split(';')
                .map((s) => s.trim())
                .find((s) => s.startsWith('CASLOGC='));
            if (!raw) return '';
            const value = raw.slice('CASLOGC='.length);
            const json = JSON.parse(decodeURIComponent(value));
            const name = String(json.realName || '').trim();
            if (!isBadName(name)) return name;
        } catch (e) {
            /* 解析失败就走 DOM 或缓存 */
        }
        return '';
    }

    function readNameFromDom() {
        for (const sel of NAME_SELECTORS) {
            const node = document.querySelector(sel);
            if (!node) continue;
            const text = (node.textContent || '').trim();
            if (!isBadName(text)) return text;
        }
        return '';
    }

    function getUserName() {
        // 来源优先级：cookie（跨子域最可靠） → DOM → 缓存
        const fresh = readNameFromCookie() || readNameFromDom();
        if (fresh) {
            if (fresh !== cachedName) {
                cachedName = fresh;
                GMs.set(NAME_CACHE_KEY, fresh);
            }
            return fresh;
        }
        return cachedName;
    }

    /* ================================================================
     *  页面状态识别
     *
     *  返回 { status } —— 只有状态，不含课程名。
     *  识别不了的返回 null，脚本保持原始标题不动。
     * ================================================================ */

    function currentHost() {
        return location.hostname.toLowerCase();
    }

    function currentPath() {
        return location.pathname.toLowerCase();
    }

    /**
     * 把“当前在哪个页面”翻译成状态文案。
     *
     * 识别规则基于实测到的真实域名与路径：
     *   onlineweb.zhihuishu.com/onlinestuh5            首页
     *   qah5.zhihuishu.com/qa.html                     问答
     *   stuonline.zhihuishu.com/.../teachMeeting/...   见面课
     *   onlineexamh5new.zhihuishu.com/stuExamWeb.html  作业 / 作业结果
     *   lc.zhihuishu.com/live/...                      直播
     *   www.zhihuishu.com                              官网
     */
    function detectState() {
        const host = currentHost();
        const path = currentPath();

        /* ---------- onlineweb：学生首页 ---------- */
        if (host === 'onlineweb.zhihuishu.com') {
            if (/^\/onlinestuh\d*\/?$/.test(path) || path === '/') return { status: '首页' };
            return { status: '在线学堂' };
        }

        /* ---------- qah5：问答（列表/详情/我的参与都叫「问答」） ---------- */
        if (host === 'qah5.zhihuishu.com') {
            return { status: '问答' };
        }

        /* ---------- onlineexamh5new：作业考试 / 作业结果，统一叫「作业」 ---------- */
        if (host === 'onlineexamh5new.zhihuishu.com') {
            return { status: '作业' };
        }

        /* ---------- stuonline：见面课 / 成绩 ---------- */
        if (host === 'stuonline.zhihuishu.com') {
            if (path.includes('/teachmeeting')) return { status: '见面课' };
            if (path.includes('/stulearnreport')) return { status: '成绩分析' };
            return { status: '课程学习' };
        }

        /* ---------- lc：直播 / 回放 ---------- */
        if (host === 'lc.zhihuishu.com') {
            return { status: '直播' };
        }

        /* ---------- www：官网 / 服务中心 ---------- */
        if (host === 'www.zhihuishu.com') {
            if (path === '/' || path === '') return { status: '官网' };
            if (path.includes('supportservice')) return { status: '服务中心' };
            if (path.includes('download')) return { status: '下载APP' };
            return { status: '官网' };
        }

        /* ---------- 其他智慧树子域：兜底用子域名 ---------- */
        const sub = host.replace(/\.zhihuishu\.com$/, '');
        if (sub && sub !== host) {
            return { status: sub };
        }

        return null; // 识别不了，别乱改标题
    }

    /* ================================================================
     *  标题合成与写入
     * ================================================================ */

    // 页面原始标题要保留一份，识别失败时用来还原
    let originalTitle = document.title;
    let lastWritten = '';

    function buildTitle(state, userName) {
        if (!state) return null;
        // 格式：状态 - 用户名；没有用户名时只写状态
        return userName ? `${state.status} - ${userName}` : state.status;
    }

    function applyTitle() {
        const state = detectState();
        const userName = getUserName();

        const next = buildTitle(state, userName);
        if (!next) {
            // 识别不了：若之前改过标题，还原成原始标题
            if (lastWritten && document.title === lastWritten) {
                writeTitle(originalTitle);
                lastWritten = '';
            }
            return;
        }
        if (document.title !== next) {
            lastWritten = next;
            writeTitle(next);
        }
    }

    // 统一出口：写入时设置 reasserting 标记，避免自己的写入又触发 observer
    let reasserting = false;
    function writeTitle(t) {
        reasserting = true;
        try {
            document.title = t;
        } finally {
            reasserting = false;
        }
    }

    /* ================================================================
     *  触发时机
     *
     *  两档：
     *
     *  1. 立即档 —— 标题被站点覆盖时，同步（0 延迟）写回。
     *     智慧树各子站会在 JS 里改 document.title（首页实测 880ms 时
     *     改回「学生首页_在线学堂_智慧树」），若不立即抢回，用户会看到
     *     「正确标题 → 站点原版标题 → 正确标题」的闪烁。
     *     这里用「同步节流」而不是防抖：同一轮微任务内只跑一次，
     *     但不延迟到下一帧。
     *
     *  2. 防抖档 —— DOM 变化 / 路由切换等，120ms 合并，
     *     避免高频重排。
     * ================================================================ */

    let scheduled = false;
    function scheduleApply(delay = 120) {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            try { applyTitle(); } catch (e) { console.warn('[标题状态] 应用失败', e); }
        }, delay);
    }

    /** 立即应用一次（不走防抖）：用于启动和菜单手动刷新 */
    function applyNow() {
        try { applyTitle(); } catch (e) { console.warn('[标题状态] 应用失败', e); }
    }

    /**
     * 同步拦截 document.title 的写入。
     *
     * 为什么必须这么做（实测依据）：
     *   智慧树首页在 app.c5e24df1.js 里通过 Vue 的标题处理函数执行
     *   document.title = '学生首页_在线学堂_智慧树'，时间点约 900ms。
     *   若只用 MutationObserver 抢回，回调被 Vue 异步批次推迟，
     *   用户会看到 300ms+ 的“站点原版标题”闪现。
     *
     * 为什么必须改 Document.prototype：
     *   实测把访问器装在 document 实例上无效——站点代码走的是原型链，
     *   实例上的属性会被绕过。只有替换原型上的描述符才能真正拦住。
     */
    function installTitleInterceptor() {
        if (titleHookInstalled) return;
        const proto = Document.prototype;
        const protoDesc = Object.getOwnPropertyDescriptor(proto, 'title');
        if (!protoDesc || !protoDesc.set) return;

        try {
            Object.defineProperty(proto, 'title', {
                configurable: true,
                enumerable: protoDesc.enumerable,
                get() {
                    return protoDesc.get.call(this);
                },
                set(v) {
                    protoDesc.set.call(this, v);
                    // 自己的写入不处理，否则无限递归
                    if (reasserting) return;
                    enforceTitle();
                },
            });
            titleHookInstalled = true;
        } catch (e) {
            console.warn('[标题状态] 无法拦截 document.title，退回观察器', e);
            watchTitleElementFallback();
        }
    }

    /** 同步校正：如果当前标题不是我们要的，立刻改回 */
    function enforceTitle() {
        if (!lastWritten) return;
        if (document.title === lastWritten) return;
        reasserting = true;
        try {
            document.title = lastWritten;
        } finally {
            reasserting = false;
        }
    }

    /** 兜底方案：拦截器装不上时，用 MutationObserver 监听 title 元素 */
    function watchTitleElementFallback() {
        const titleEl = document.querySelector('title');
        if (!titleEl) return;
        const mo = new MutationObserver(() => {
            if (reasserting) return;
            enforceTitle();
        });
        mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    let titleHookInstalled = false;

    function watchBody() {
        if (!document.body) return false;
        const mo = new MutationObserver(() => {
            // 只关心用户名是否出现；节流交给 scheduleApply
            if (!cachedName) scheduleApply();
        });
        mo.observe(document.body, { childList: true, subtree: true });
        return true;
    }

    /* ================================================================
     *  启动
     * ================================================================ */

    function boot() {
        originalTitle = document.title;
        // 先装拦截器再写标题：这样站点之后任何一次改标题都会被同步抢回
        installTitleInterceptor();
        applyNow();

        window.addEventListener('hashchange', scheduleApply);
        window.addEventListener('popstate', scheduleApply);

        if (!watchBody()) {
            document.addEventListener('DOMContentLoaded', () => {
                watchBody();
                scheduleApply();
            }, { once: true });
        }

        // 用户名异步渲染 + SPA 内部路由不触发 hashchange 的情况，定时兜底
        // 前 5 秒每 500ms，之后降为每 3 秒，避免长期占用
        let ticks = 0;
        const fast = setInterval(() => {
            ticks += 1;
            scheduleApply();
            if (ticks >= 10) {
                clearInterval(fast);
                setInterval(scheduleApply, 3000);
            }
        }, 500);

        // 调试用：脚本管理器菜单里可强制刷新一次
        GMs.menu('刷新标题状态', applyNow);

        console.log(`[标题状态] v${SCRIPT_VERSION} 已启动`);
    }

    // run-at document-start：此时 document 已存在（Document.prototype.title 可用），
    // 但 <title> 元素和 body 可能都还没建好。
    // 标题拦截装在 document 实例上，不依赖 <title> 元素是否已插入；
    // 用户名缺省时后续会由定时兜底和 body 观察器补上。
    boot();
})();
