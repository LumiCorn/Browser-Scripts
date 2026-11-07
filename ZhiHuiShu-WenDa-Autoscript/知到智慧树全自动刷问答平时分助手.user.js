// ==UserScript==
// @name         智慧树-互动分（问答）自动化
// @version      2.9.0
// @description  通过AI快速地，全自动刷智慧树问答：回答模式自动回答前N条问题（达标即停），提问模式全自动AI提问并自动发布；现代化可拖拽悬浮面板，半自动化可选择地提问，防重复、防无效问题。
// @author       LumiCornX
// @match      	 *://qah5.zhihuishu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @license      MIT
// ==/UserScript==

(function () {

    'use strict';

    const defaultAPIKey = "REMOVED_LEAKED_KEY";
    const defaultAPIUrl = "https://api.gpt.ge/v1/chat/completions";
    const defaultModel = "glm-4-flash";
    const intervalTime = GM_getValue("intervalTime", 2000);
    const initialCountdownTime = GM_getValue("countdownTime", 20);

    const SCRIPT_VERSION = "2.9.0";
    const ASK_DIALOG_SELECTOR = 'div[role="dialog"][aria-modal="true"][aria-label="提问"].el-dialog';

    let requestLock = false;
    let noAnswerButtonCount = 0;
    let countdownInterval;
    let askLock = false;
    let waitingForChild = false;   // 父页面：已开子页面，挂起等待其汇报
    let childWaitTimeout = null;   // 等待子页面的兜底超时定时器

    const inputEvent = new Event("input", { bubbles: true, cancelable: true });

    /* ---------- 父子页面分工 ----------
       父页面 = 问答列表页（#/web/home/...）：负责同步、跳题、倒计时、开子页面。
       子页面 = 题目详情页（#/web/questionDetail/...）：由父页面打开，
       只干一件事——回答本题，答完向父页面汇报后自动关闭。
       子页面绝不启动倒计时/同步/跳题，避免“详情页里又跑一遍整套流程”的死循环。 */

    const DETAIL_HASH_PATTERN = /#\/web\/questionDetail\/\d+/;

    function isDetailPage() {
        return DETAIL_HASH_PATTERN.test(location.hash);
    }

    function reportToParent(questionText, status) {
        try {
            GM_setValue("zhsAnswerReport", JSON.stringify({
                ts: Date.now(),
                question: questionText,
                status: status,
                version: SCRIPT_VERSION
            }));
        } catch (e) { /* 汇报失败不影响关闭页面 */ }
    }

    // 取消“等待子页面”状态（手动暂停/切模式/强制下一题/同步时使用）
    function cancelChildWait() {
        waitingForChild = false;
        if (childWaitTimeout) {
            clearTimeout(childWaitTimeout);
            childWaitTimeout = null;
        }
    }

    /* ---------- 子页面监控 UI：题目 / 状态 / AI 回答 / 操作日志 ---------- */

    function ensureChildPanel() {
        if (!isDetailPage()) return null;
        let p = document.getElementById('zhsChildPanel');
        if (!p) {
            injectStyles();
            p = document.createElement('div');
            p.id = 'zhsChildPanel';
            p.className = 'zhs-child-panel';
            p.innerHTML = `
                <div class="zhs-child-header"><span>🤖 答题监控</span><span class="zhs-child-ver">v${SCRIPT_VERSION}</span></div>
                <div class="zhs-child-body">
                    <div class="zhs-child-q" id="zhsChildQ">正在读取题目…</div>
                    <div class="zhs-child-status"><span class="zhs-child-dot" id="zhsChildDot"></span><span id="zhsChildStatus">初始化…</span></div>
                    <div class="zhs-child-answer" id="zhsChildAnswer"></div>
                    <div class="zhs-child-log" id="zhsChildLog"></div>
                </div>`;
            document.body.appendChild(p);
        }
        return p;
    }

    function setChildStatus(text, state = 'run') {
        const el = document.getElementById('zhsChildStatus');
        const dot = document.getElementById('zhsChildDot');
        if (el) el.textContent = text;
        if (dot) dot.className = 'zhs-child-dot' + (state === 'run' ? '' : ' ' + state);
    }

    function childLog(text, state = '') {
        const log = document.getElementById('zhsChildLog');
        if (!log) return;
        const d = new Date();
        const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        const line = document.createElement('div');
        if (state) line.className = state;
        line.dataset.t = t;
        line.textContent = text;
        log.appendChild(line);
        while (log.childNodes.length > 30) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
    }

    /* ---------- 母页面运行日志窗：所有提示持久留存，方便回看（Toast 一闪而过） ---------- */

    function parentLog(text, state = '') {
        if (isDetailPage()) return; // 子页面有自己的监控面板，不重复记录
        let p = document.getElementById('zhsLogPanel');
        if (!p) {
            injectStyles();
            p = document.createElement('div');
            p.id = 'zhsLogPanel';
            p.className = 'zhs-child-panel'; // 复用子页面监控面板样式（左下角悬浮）
            p.innerHTML = `
                <div class="zhs-child-header">
                    <span>📋 运行日志</span>
                    <span style="display:flex;gap:6px;align-items:center;">
                        <button class="zhs-icon-btn" id="zhsLogClear" title="清空日志">🗑</button>
                        <button class="zhs-icon-btn" id="zhsLogFold" title="折叠/展开">—</button>
                    </span>
                </div>
                <div class="zhs-child-body" id="zhsLogBody">
                    <div class="zhs-child-log" id="zhsLogList" style="max-height:180px;"></div>
                </div>`;
            document.body.appendChild(p);
            p.querySelector('#zhsLogClear').addEventListener('click', (e) => {
                e.stopPropagation();
                const l = p.querySelector('#zhsLogList');
                if (l) l.innerHTML = '';
            });
            p.querySelector('#zhsLogFold').addEventListener('click', (e) => {
                e.stopPropagation();
                const body = p.querySelector('#zhsLogBody');
                const folding = body.style.display !== 'none';
                body.style.display = folding ? 'none' : '';
                e.target.textContent = folding ? '▢' : '—';
            });
        }
        const log = p.querySelector('#zhsLogList');
        if (!log) return;
        const d = new Date();
        const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        const line = document.createElement('div');
        if (state) line.className = state;
        line.dataset.t = t;
        line.textContent = text;
        log.appendChild(line);
        while (log.childNodes.length > 50) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
    }

    function updateChildQuestion() {
        const qEl = document.getElementById('zhsChildQ');
        const src = document.querySelector(".question-content span");
        const text = src ? src.innerText.trim() : '';
        if (qEl && text) qEl.textContent = text;
        return text;
    }

    function showChildAnswer(answer) {
        const el = document.getElementById('zhsChildAnswer');
        if (!el) return;
        el.textContent = answer.length > 300 ? answer.slice(0, 300) + '…' : answer;
        el.style.display = 'block';
    }

    // 父页面进入等待子页面状态：暂停倒计时，收到汇报或超时后恢复
    function beginChildWait() {
        cancelChildWait();
        waitingForChild = true;
        showAlert("已打开子页面答题，本页暂停等待结果…");
        // 兜底：子页面 150 秒无汇报则恢复倒计时，避免永久挂起
        childWaitTimeout = setTimeout(() => {
            if (waitingForChild) {
                waitingForChild = false;
                childWaitTimeout = null;
                showAlert("等待子页面超时（可能已关闭未汇报），恢复倒计时继续");
                startCountdown();
                updatePanel();
            }
        }, 150000);
        updatePanel();
    }

    // 父页面：接收子页面汇报（变更监听 + 每秒轮询兜底）
    let lastReportTs = 0;
    function handleChildReport() {
        let r = null;
        try { r = JSON.parse(GM_getValue("zhsAnswerReport", "null")); } catch (e) { /* 忽略坏数据 */ }
        if (!r || typeof r.ts !== "number" || r.ts <= lastReportTs) return;
        lastReportTs = r.ts;
        const shortQ = (r.question || "").slice(0, 20);
        showAlert(`子页面反馈：「${shortQ}${r.question && r.question.length > 20 ? "…" : ""}」${r.status || "已完成"}`);
        // 子页面真正新答完一题（“原本已答过，直接关闭”的不算）：脚本计数 +1，
        // 并驱动“每 5 题刷新比对 / 计数达标刷新复核”
        if (r.status === "已回答") {
            const n = bumpScriptAnswered();
            parentLog(`✅ 答题成功，脚本累计已答 ${n} 题`);
            const target = GM_getValue("answerTarget", 50);
            if (n >= target && getVerifyDone() < target) {
                // 脚本计数达标：刷新页面复核一次官方数字（每门课只复核一次）
                markVerifyDone(n);
                sessionStorage.setItem("zhsTargetVerify", "1");
                showAlert(`脚本计数已达 ${n} 题（目标 ${target}），2 秒后刷新复核官方数据…`);
                parentLog(`脚本计数达标（${n}/${target}），刷新复核官方数据`);
                setTimeout(() => location.reload(), 2000);
            } else if (n % 5 === 0) {
                // 每答满 5 题刷新一次，与官方“我的回答”比对
                sessionStorage.setItem("zhsCountCheck", "1");
                showAlert(`已答满 ${n} 题，2 秒后刷新页面与官方数据比对…`);
                parentLog(`已答满 ${n} 题，刷新与官方数据比对`);
                setTimeout(() => location.reload(), 2000);
            }
        }
        // 若父页面正挂起等待本题结果：恢复倒计时，进入下一轮
        if (waitingForChild) {
            cancelChildWait();
            console.log("收到子页面汇报，恢复工作循环");
            startCountdown();
        }
        updatePanel();
    }

    if (typeof GM_addValueChangeListener === "function") {
        try {
            GM_addValueChangeListener("zhsAnswerReport", (name, oldVal, newVal) => {
                // 只有非详情页（父页面）处理汇报
                if (!isDetailPage()) handleChildReport();
            });
        } catch (e) { /* 不支持监听时靠轮询兜底 */ }
    }

    function debounce(fn, delay) {
        let timeout;
        return function () {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, arguments), delay);
        };
    }

    function getCurrentCourse() {
        const courseNameElement = document.querySelector(".course-name");
        return courseNameElement ? courseNameElement.innerText.trim() : '当前课程';
    }

    /* ==================== 现代化样式 ==================== */

    function injectStyles() {
        if (document.getElementById('zhs-style')) return;
        const style = document.createElement('style');
        style.id = 'zhs-style';
        style.textContent = `
            /* ---------- Material Design 3 设计令牌（蓝白主题，参考 m3-web-vanilla） ---------- */
            :root {
                --md-sys-color-primary: #2563eb;
                --md-sys-color-on-primary: #ffffff;
                --md-sys-color-primary-container: #dbe7fe;
                --md-sys-color-on-primary-container: #0b2a6b;
                --md-sys-color-secondary-container: #e0e2ec;
                --md-sys-color-on-secondary-container: #191c26;
                --md-sys-color-error: #dc2626;
                --md-sys-color-on-error: #ffffff;
                --md-sys-color-surface: #ffffff;
                --md-sys-color-on-surface: #1a1c1e;
                --md-sys-color-surface-variant: #f3f4f6;
                --md-sys-color-on-surface-variant: #4b5563;
                --md-sys-color-surface-container-low: #f8f9fb;
                --md-sys-color-outline: #9ca3af;
                --md-sys-color-outline-variant: #e5e7eb;
                --md-state-hover: 0.08;
                --md-shape-small: 8px;
                --md-shape-medium: 12px;
                --md-shape-large: 16px;
                --md-shape-full: 9999px;
                --md-ele-1: 0 1px 2px rgba(17,24,39,.30), 0 1px 3px 1px rgba(17,24,39,.15);
                --md-ele-2: 0 2px 6px 2px rgba(17,24,39,.15), 0 1px 2px rgba(17,24,39,.30);
                --md-ele-3: 0 8px 24px rgba(17,24,39,.12);
                --md-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }

            /* ---------- 悬浮主面板（M3 Elevated Card） ---------- */
            .zhs-panel {
                position: fixed;
                top: 90px;
                right: 24px;
                width: 320px;
                background: var(--md-sys-color-surface);
                border-radius: var(--md-shape-large);
                box-shadow: var(--md-ele-2);
                color: var(--md-sys-color-on-surface);
                font-family: var(--md-font);
                font-size: 13px;
                z-index: 999999;
                overflow: hidden;
                user-select: none;
            }
            .zhs-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 16px;
                background: var(--md-sys-color-surface);
                border-bottom: 1px solid var(--md-sys-color-outline-variant);
                cursor: move;
            }
            .zhs-logo { font-size: 15px; }
            .zhs-title {
                font-weight: 500; font-size: 15px; color: var(--md-sys-color-on-surface);
                flex: 1; letter-spacing: .15px;
            }
            .zhs-ver {
                font-size: 10px; font-weight: normal; color: var(--md-sys-color-on-surface-variant);
                background: var(--md-sys-color-surface-variant); padding: 2px 7px; border-radius: var(--md-shape-full);
                margin-left: 4px;
            }
            .zhs-icon-btn {
                background: transparent; border: none; color: var(--md-sys-color-on-surface-variant);
                width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
                font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center;
                transition: background .15s;
            }
            .zhs-icon-btn:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent); }
            .zhs-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
            .zhs-panel.collapsed .zhs-body { display: none; }

            /* M3 Segmented Button：模式切换 */
            .zhs-mode-switch {
                display: flex; background: var(--md-sys-color-surface-variant);
                border-radius: var(--md-shape-full); padding: 3px; gap: 2px;
                border: 1px solid var(--md-sys-color-outline-variant);
            }
            .zhs-mode-btn {
                flex: 1; border: none; background: transparent; color: var(--md-sys-color-on-surface-variant);
                padding: 8px 0; border-radius: var(--md-shape-full); cursor: pointer; font-size: 13px;
                transition: all .18s; font-family: inherit; font-weight: 500; letter-spacing: .1px;
            }
            .zhs-mode-btn:hover { color: var(--md-sys-color-on-surface); }
            .zhs-mode-btn.active {
                background: var(--md-sys-color-surface); color: var(--md-sys-color-primary);
                font-weight: 600; box-shadow: var(--md-ele-1);
            }

            .zhs-status-row {
                display: flex; align-items: center; gap: 7px;
                color: var(--md-sys-color-on-surface-variant); font-size: 12px;
            }
            .zhs-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background: #16a34a;
            }
            .zhs-dot.paused { background: #d97706; }
            .zhs-dot.done { background: var(--md-sys-color-primary); }
            .zhs-countdown { margin-left: auto; color: var(--md-sys-color-outline); }
            .zhs-countdown b { color: var(--md-sys-color-on-surface); font-size: 14px; font-variant-numeric: tabular-nums; }

            .zhs-progress-info {
                display: flex; justify-content: space-between;
                font-size: 12px; color: var(--md-sys-color-on-surface-variant); margin-bottom: 5px;
            }
            .zhs-progress-track {
                height: 6px; border-radius: var(--md-shape-full);
                background: var(--md-sys-color-surface-variant); overflow: hidden;
            }
            .zhs-progress-fill {
                height: 100%; width: 0%;
                background: var(--md-sys-color-primary);
                border-radius: var(--md-shape-full); transition: width .4s ease;
            }

            /* M3 Buttons：主按钮为 Filled Pill，次按钮为 Outlined Pill */
            .zhs-actions { display: flex; gap: 8px; flex-wrap: wrap; }
            .zhs-btn {
                border: none; border-radius: var(--md-shape-full); padding: 8px 16px;
                font-size: 12.5px; cursor: pointer; font-weight: 500;
                transition: all .15s; color: var(--md-sys-color-on-surface-variant);
                font-family: inherit; letter-spacing: .1px;
            }
            .zhs-btn.primary {
                background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary);
            }
            .zhs-btn.primary:hover {
                background: color-mix(in srgb, var(--md-sys-color-on-primary) var(--md-state-hover), var(--md-sys-color-primary));
                box-shadow: var(--md-ele-1);
            }
            .zhs-btn.ghost {
                background: transparent; border: 1px solid var(--md-sys-color-outline-variant);
            }
            .zhs-btn.ghost:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent); }
            .zhs-btn.ghost.on {
                background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
                border: 1px solid var(--md-sys-color-primary-container);
            }

            .zhs-settings summary {
                cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;
                padding: 4px 0; list-style: none;
            }
            .zhs-settings summary::before { content: '▸ '; }
            .zhs-settings[open] summary::before { content: '▾ '; }
            .zhs-settings[open] summary { margin-bottom: 10px; }
            .zhs-settings > div { display: flex; flex-direction: column; gap: 9px; }
            .zhs-field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
            .zhs-field label { font-size: 11px; color: var(--md-sys-color-on-surface-variant); }
            /* M3 Outlined Text Field */
            .zhs-field input, .zhs-field select {
                background: var(--md-sys-color-surface);
                border: 1px solid var(--md-sys-color-outline);
                border-radius: var(--md-shape-small); padding: 8px 10px;
                color: var(--md-sys-color-on-surface); font-size: 12.5px; outline: none;
                width: 100%; box-sizing: border-box;
                font-family: inherit;
                transition: border-color .15s, border-width .05s;
            }
            .zhs-field input:hover, .zhs-field select:hover { border-color: var(--md-sys-color-on-surface-variant); }
            .zhs-field input:focus, .zhs-field select:focus {
                border-color: var(--md-sys-color-primary); border-width: 2px; padding: 7px 9px;
            }
            .zhs-field-row { display: flex; gap: 8px; }

            /* M3 Dropdown（Exposed Menu） */
            .zhs-dropdown { position: relative; }
            .zhs-dropdown-selected {
                background: var(--md-sys-color-surface);
                border: 1px solid var(--md-sys-color-outline);
                border-radius: var(--md-shape-small); padding: 8px 10px;
                cursor: pointer; font-size: 12.5px; color: var(--md-sys-color-on-surface);
                display: flex; justify-content: space-between; align-items: center;
                transition: border-color .15s;
            }
            .zhs-dropdown-selected:hover { border-color: var(--md-sys-color-on-surface-variant); }
            .zhs-dropdown-selected::after { content: '▾'; color: var(--md-sys-color-outline); font-size: 10px; }
            .zhs-dropdown-options {
                position: absolute; top: calc(100% + 4px); left: 0; right: 0;
                background: var(--md-sys-color-surface-container-low);
                border-radius: var(--md-shape-small); overflow: hidden;
                display: none; z-index: 10;
                max-height: 220px; overflow-y: auto;
                box-shadow: var(--md-ele-2);
            }
            .zhs-dropdown-item {
                padding: 8px 12px; cursor: pointer; font-size: 12.5px;
                display: flex; justify-content: space-between; align-items: center;
                color: var(--md-sys-color-on-surface);
                transition: background .12s;
            }
            .zhs-dropdown-item:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent); }
            .zhs-remove-model { color: var(--md-sys-color-error); cursor: pointer; }
            .zhs-add-model { display: flex; gap: 5px; padding: 8px; }
            .zhs-add-model input {
                flex: 1; background: var(--md-sys-color-surface);
                border: 1px solid var(--md-sys-color-outline); border-radius: var(--md-shape-small);
                padding: 6px 8px; color: var(--md-sys-color-on-surface); font-size: 12px; outline: none;
                font-family: inherit;
            }

            .zhs-links {
                display: flex; align-items: center; gap: 10px;
                font-size: 11px; color: var(--md-sys-color-outline); flex-wrap: wrap;
            }
            .zhs-links a { color: var(--md-sys-color-primary); text-decoration: none; }
            .zhs-info { cursor: help; position: relative; color: var(--md-sys-color-on-surface-variant); }
            .zhs-tooltip {
                position: fixed; background: var(--md-sys-color-surface-container-low);
                color: var(--md-sys-color-on-surface-variant);
                padding: 12px 14px; border-radius: var(--md-shape-medium);
                font-size: 12px; width: 240px; z-index: 9999999;
                box-shadow: var(--md-ele-2);
                white-space: pre-wrap; line-height: 1.6;
            }

            /* ---------- Toast 提示（M3 Snackbar 风格） ---------- */
            #alert-stack {
                position: fixed; bottom: 20px; left: 50%;
                transform: translateX(-50%);
                z-index: 99999999;
                display: flex; flex-direction: column-reverse; gap: 8px;
                pointer-events: none;
            }
            .zhs-toast {
                background: var(--md-sys-color-surface-container-low);
                border: none;
                border-left: 3px solid var(--md-sys-color-primary);
                color: var(--md-sys-color-on-surface); padding: 12px 18px;
                border-radius: var(--md-shape-medium); font-size: 13px;
                box-shadow: var(--md-ele-2);
                opacity: 0; transform: translateY(8px);
                transition: opacity 0.25s, transform 0.25s;
                max-width: 70vw;
            }
            .zhs-toast.show { opacity: 1; transform: translateY(0); }

            /* ---------- 提问弹窗里的“生成问题”按钮（M3 Filled Button） ---------- */
            .zhs-gen-btn {
                display: inline-flex; align-items: center; gap: 6px;
                margin-right: 20px; padding: 8px 18px;
                border: none; border-radius: var(--md-shape-full);
                background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary);
                font-size: 13px; font-weight: 500;
                cursor: pointer; font-family: inherit; letter-spacing: .1px;
            }
            .zhs-gen-btn:hover {
                background: color-mix(in srgb, var(--md-sys-color-on-primary) var(--md-state-hover), var(--md-sys-color-primary));
                box-shadow: var(--md-ele-1);
            }

            /* ---------- 问题管理弹窗（M3 Dialog） ---------- */
            .question-management-modal {
                position: fixed; top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                width: min(860px, 92vw); height: min(640px, 86vh);
                background: var(--md-sys-color-surface); border-radius: var(--md-shape-large);
                box-shadow: var(--md-ele-3);
                z-index: 1000000; overflow: hidden;
                display: flex; flex-direction: column;
                font-family: var(--md-font);
                font-size: 13px; color: var(--md-sys-color-on-surface);
            }
            .zhs-modal-tabs {
                display: flex; justify-content: center; gap: 4px;
                padding: 14px 60px 0; border-bottom: 1px solid var(--md-sys-color-outline-variant);
                flex-wrap: wrap;
            }
            .zhs-modal-tab {
                padding: 9px 16px; cursor: pointer;
                color: var(--md-sys-color-on-surface-variant); transition: all .15s; font-weight: 500;
                border-radius: var(--md-shape-full);
            }
            .zhs-modal-tab:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent); }
            .zhs-modal-tab.active {
                background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
            }
            .zhs-modal-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
            .zhs-modal-tablewrap { flex: 1; overflow: auto; padding: 0 18px; }
            .zhs-modal-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .zhs-modal-table thead th {
                position: sticky; top: 0; background: var(--md-sys-color-surface-container-low);
                color: var(--md-sys-color-on-surface-variant);
                padding: 10px; text-align: left; font-weight: 600; z-index: 1;
                border-bottom: 1px solid var(--md-sys-color-outline-variant);
            }
            .zhs-modal-table tbody td {
                padding: 10px; border-bottom: 1px solid var(--md-sys-color-outline-variant);
                word-break: break-word;
            }
            .zhs-modal-table .zhs-tag-ok { color: #16a34a; font-weight: 600; }
            .zhs-modal-table .zhs-tag-no { color: var(--md-sys-color-error); font-weight: 600; }
            .zhs-modal-table .zhs-tag-na { color: #d97706; font-weight: 600; }
            .zhs-mini-btn {
                border: none; border-radius: var(--md-shape-full); padding: 6px 12px;
                font-size: 12px; cursor: pointer; color: #ffffff;
                font-family: inherit; margin-right: 5px; letter-spacing: .1px;
            }
            .zhs-mini-btn.ok { background: #16a34a; }
            .zhs-mini-btn.no { background: var(--md-sys-color-error); }
            .zhs-mini-btn.blue { background: var(--md-sys-color-primary); }
            .zhs-mini-btn.gray { background: var(--md-sys-color-surface-variant); color: var(--md-sys-color-on-surface-variant); }
            .zhs-mini-btn.gray:hover { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
            .zhs-modal-search {
                margin-left: 8px; padding: 5px 10px; border-radius: var(--md-shape-full);
                border: 1px solid var(--md-sys-color-outline); color: var(--md-sys-color-on-surface); font-size: 12px;
                width: 150px; outline: none; font-family: inherit;
                transition: border-color .15s;
            }
            .zhs-modal-search:hover { border-color: var(--md-sys-color-on-surface-variant); }
            .zhs-modal-search:focus { border-color: var(--md-sys-color-primary); border-width: 2px; }
            .zhs-modal-footer {
                display: flex; justify-content: space-between; align-items: center;
                gap: 10px; padding: 12px 18px;
                background: var(--md-sys-color-surface-container-low);
                border-top: 1px solid var(--md-sys-color-outline-variant);
                flex-wrap: wrap;
            }
            .zhs-modal-footer .group { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
            .zhs-modal-footer input[type="number"] {
                width: 58px; padding: 5px 8px; border-radius: var(--md-shape-small);
                border: 1px solid var(--md-sys-color-outline); font-size: 12px; outline: none;
                font-family: inherit;
            }
            .zhs-modal-footer input[type="number"]:focus { border-color: var(--md-sys-color-primary); }
            .zhs-modal-pageinfo { color: var(--md-sys-color-outline); }
            .zhs-modal-close {
                position: absolute; top: 12px; right: 14px;
                width: 28px; height: 28px; border: none; border-radius: 50%;
                background: transparent; color: var(--md-sys-color-on-surface-variant); cursor: pointer;
                font-size: 14px; line-height: 1;
                transition: background .15s;
            }
            .zhs-modal-close:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent); }

            /* ---------- “回归位置”找回按钮（M3 Outlined Button） ---------- */
            .zhs-restore-btn {
                display: block; width: 100%; margin: 10px 0 0;
                padding: 8px 0; border: 1px solid var(--md-sys-color-outline-variant);
                border-radius: var(--md-shape-full);
                background: transparent; color: var(--md-sys-color-primary); font-size: 12.5px;
                cursor: pointer; font-family: inherit; text-align: center;
                box-sizing: border-box; font-weight: 500;
                transition: background .15s;
            }
            .zhs-restore-btn:hover { background: color-mix(in srgb, var(--md-sys-color-primary) var(--md-state-hover), transparent); }

            /* ---------- 子页面答题监控面板（M3 Elevated Card） ---------- */
            .zhs-child-panel {
                position: fixed; left: 16px; bottom: 16px; width: 320px;
                background: var(--md-sys-color-surface); border-radius: var(--md-shape-large);
                box-shadow: var(--md-ele-2);
                z-index: 999999; overflow: hidden;
                font-family: var(--md-font);
                font-size: 12.5px; color: var(--md-sys-color-on-surface);
            }
            .zhs-child-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 14px; border-bottom: 1px solid var(--md-sys-color-outline-variant);
                font-weight: 500; font-size: 13px;
            }
            .zhs-child-ver {
                font-size: 10px; font-weight: normal; color: var(--md-sys-color-on-surface-variant);
                background: var(--md-sys-color-surface-variant); padding: 2px 7px; border-radius: var(--md-shape-full);
            }
            .zhs-child-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
            .zhs-child-q {
                background: var(--md-sys-color-surface-container-low);
                border-radius: var(--md-shape-small);
                padding: 8px 10px; line-height: 1.6; word-break: break-word;
            }
            .zhs-child-q::before { content: '题目  '; color: var(--md-sys-color-outline); font-size: 11px; }
            .zhs-child-status { display: flex; align-items: center; gap: 6px; color: var(--md-sys-color-on-surface-variant); }
            .zhs-child-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--md-sys-color-primary); flex-shrink: 0; }
            .zhs-child-dot.ok { background: #16a34a; }
            .zhs-child-dot.err { background: var(--md-sys-color-error); }
            .zhs-child-dot.wait { background: #d97706; }
            .zhs-child-answer {
                display: none; background: var(--md-sys-color-primary-container);
                border-radius: var(--md-shape-small); padding: 8px 10px; line-height: 1.6;
                color: var(--md-sys-color-on-primary-container); word-break: break-word;
            }
            .zhs-child-answer::before { content: 'AI 回答  '; display: block; color: var(--md-sys-color-primary); font-size: 11px; margin-bottom: 3px; font-weight: 600; }
            .zhs-child-log {
                max-height: 140px; overflow-y: auto;
                display: flex; flex-direction: column; gap: 3px;
                border-top: 1px dashed var(--md-sys-color-outline-variant); padding-top: 7px;
            }
            .zhs-child-log div { color: var(--md-sys-color-on-surface-variant); font-size: 11.5px; line-height: 1.5; word-break: break-all; }
            .zhs-child-log div::before { content: attr(data-t) '  '; color: var(--md-sys-color-outline); font-size: 10.5px; font-variant-numeric: tabular-nums; }
            .zhs-child-log div.ok { color: #16a34a; }
            .zhs-child-log div.err { color: var(--md-sys-color-error); }
        `;
        document.head.appendChild(style);
    }

    /* ==================== Toast 提示 ==================== */

    function showAlert(message) {
        console.log('Alert:', message);
        parentLog(message); // 母页面：提示同时落入左下角运行日志窗，持久可回看
        if (document.hidden) return;

        let alertStack = document.getElementById('alert-stack');
        if (!alertStack) {
            alertStack = document.createElement('div');
            alertStack.id = 'alert-stack';
            document.body.appendChild(alertStack);
        }

        const toast = document.createElement('div');
        toast.className = 'zhs-toast';
        toast.innerText = message;
        alertStack.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                if (alertStack.childNodes.length === 0 && alertStack.parentNode) {
                    alertStack.parentNode.removeChild(alertStack);
                }
            }, 300);
        }, 2500);
    }

    /* ==================== 悬浮主面板 ==================== */

    function getAnsweredCount() {
        const data = GM_getValue("questionsData", {});
        const courseData = data[getCurrentCourse()] || {};
        return Object.values(courseData).filter(s => s === "已回答").length;
    }

    /* ---------- 脚本答题计数（本次运行新答的题数） ----------
       官方“我的回答”数字更新有延迟，不能实时反映脚本进度，
       所以每次收到子页面“已回答”汇报时手动 +1，作为脚本自己的进度基准。 */

    function getScriptAnsweredCount() {
        const c = GM_getValue("scriptAnswered", {});
        return c[getCurrentCourse()] || 0;
    }

    function bumpScriptAnswered() {
        const c = GM_getValue("scriptAnswered", {});
        const course = getCurrentCourse();
        c[course] = (c[course] || 0) + 1;
        GM_setValue("scriptAnswered", c);
        return c[course];
    }

    // 达标复核只做一次（每门课）：脚本计数达标后刷新验证过一次就不再重复
    function getVerifyDone() {
        const v = GM_getValue("scriptVerifyDone", {});
        return v[getCurrentCourse()] || 0;
    }

    function markVerifyDone(count) {
        const v = GM_getValue("scriptVerifyDone", {});
        v[getCurrentCourse()] = count;
        GM_setValue("scriptVerifyDone", v);
    }

    function getAskedList() {
        const asked = GM_getValue("askedQuestions", {});
        return asked[getCurrentCourse()] || [];
    }

    /* ---------- 官方页面统计（“我的参与”栏目） ---------- */

    function readOfficialCounts() {
        const result = { answer: null, asked: null };
        document.querySelectorAll('.MyParticipatory-div li').forEach(li => {
            const name = li.querySelector('.qa_jion_name')?.textContent.trim();
            const numEl = li.querySelector('.qa_jion_num');
            const val = numEl ? parseInt(numEl.textContent.trim()) : NaN;
            if (isNaN(val)) return;
            if (name === '我的回答') result.answer = val;
            else if (name === '我的提问') result.asked = val;
        });
        return result;
    }

    // 当前模式对应的官方数值（读不到时返回 null）
    function getOfficialProgress() {
        const official = readOfficialCounts();
        return GM_getValue("workMode", "answer") === "answer" ? official.answer : official.asked;
    }

    function isTargetReached() {
        const mode = GM_getValue("workMode", "answer");
        const target = mode === "answer"
            ? GM_getValue("answerTarget", 50)
            : GM_getValue("askTarget", 10);
        // 页面"我参与的"官方数字能读到时，始终以官方为准判断达标；
        // 读不到（栏目未加载/页面改版）才退回脚本内部统计
        const official = getOfficialProgress();
        if (official !== null) return official >= target;
        return mode === "answer"
            ? getAnsweredCount() >= target
            : getAskedList().length >= target;
    }

    /* ---------- 数据停滞检测：先作答、后比对，连续 N 次无变化才刷新 ---------- */

    let workAttemptsSinceChange = 0;  // 连续作答后官方数据未变化的次数
    let baselineOfficial = null;      // 上一次作答前的官方数字快照

    function resetStagnation() {
        workAttemptsSinceChange = 0;
        baselineOfficial = null;
    }

    function getDefaultModels() {
        return ["glm-4-flash", "gemini-2.0-flash", "doubao-1-5-lite-32k"];
    }

    function getAllModels() {
        return [...getDefaultModels(), ...GM_getValue("customModels", [])];
    }

    function createPanel() {
        const element = document.createElement('div');
        element.id = 'zhsPanel';
        element.className = 'zhs-panel' + (GM_getValue("panelCollapsed", false) ? ' collapsed' : '');

        const selectedModel = GM_getValue("aimodel", defaultModel);
        const linkClicked = GM_getValue("linkClicked", false);

        element.innerHTML = `
            <div class="zhs-header">
                <span class="zhs-logo">🎓</span>
                <span class="zhs-title">智慧树问答助手<span class="zhs-ver">v${SCRIPT_VERSION}</span></span>
                <button class="zhs-icon-btn" id="zhsCollapseBtn" title="折叠/展开">—</button>
            </div>
            <div class="zhs-body">
                <div class="zhs-mode-switch">
                    <button class="zhs-mode-btn" data-mode="answer">回答模式</button>
                    <button class="zhs-mode-btn" data-mode="ask">提问模式</button>
                </div>
                <div class="zhs-status-row">
                    <span class="zhs-dot" id="zhsDot"></span>
                    <span id="zhsStatus">初始化...</span>
                    <span class="zhs-countdown">下次动作 <b id="zhsCountdown">--</b> 秒</span>
                </div>
                <div>
                    <div class="zhs-progress-info">
                        <span id="zhsProgressText">-</span>
                        <span id="zhsProgressSub"></span>
                    </div>
                    <div class="zhs-progress-track"><div class="zhs-progress-fill" id="zhsProgressFill"></div></div>
                </div>
                <div class="zhs-actions">
                    <button class="zhs-btn primary" id="zhsToggleBtn">暂停</button>
                    <button class="zhs-btn ghost" id="zhsJumpBtn">跳转未答</button>
                    <button class="zhs-btn ghost" id="zhsScrollBtn">自动滚动</button>
                    <button class="zhs-btn ghost" id="zhsNextBtn">强制下一题</button>
                    <button class="zhs-btn ghost" id="zhsSyncBtn" title="读取官方“我的回答”列表，把答过的题直接标记为已回答，不用逐个点开">同步已答</button>
                </div>
                <details class="zhs-settings">
                    <summary>API 与参数设置</summary>
                    <div>
                        <div class="zhs-field">
                            <label>API_KEY</label>
                            <input type="text" id="apiKeyInput">
                        </div>
                        <div class="zhs-field">
                            <label>API_URL</label>
                            <input type="text" id="apiUrlInput">
                        </div>
                        <div class="zhs-field">
                            <label>模型</label>
                            <div class="zhs-dropdown" id="modelDropdown">
                                <div class="zhs-dropdown-selected" id="modelDropdownSelected">${selectedModel}</div>
                                <div class="zhs-dropdown-options" id="modelDropdownOptions"></div>
                            </div>
                        </div>
                        <div class="zhs-field-row">
                            <div class="zhs-field">
                                <label>回答目标(条)</label>
                                <input type="number" id="answerTargetInput">
                            </div>
                            <div class="zhs-field">
                                <label>提问目标(条)</label>
                                <input type="number" id="askTargetInput">
                            </div>
                        </div>
                        <div class="zhs-field">
                            <label>倒计时间隔固定 5 秒，不可调节</label>
                        </div>
                        <div class="zhs-field">
                            <label>官方数据连续 N 轮无变化则自动刷新页面（N≥2，需开启下方官方数据功能）</label>
                            <input type="number" id="stagnantLimitInput">
                        </div>
                        <div class="zhs-field" style="flex-direction:row; align-items:center; gap:8px;">
                            <input type="checkbox" id="useOfficialDataInput" style="width:auto; accent-color:#2563eb;">
                            <label style="font-size:12px;">使用页面“我的参与”官方数据判断目标（实验性，默认关闭）</label>
                        </div>
                        <div class="zhs-actions">
                            <button class="zhs-btn primary" id="zhsSaveBtn">保存设置</button>
                            <button class="zhs-btn ghost" id="zhsManageBtn">管理答题列表</button>
                        </div>
                        <div class="zhs-links">
                            ${linkClicked ? '' : '<a href="#" id="purchaseLink">注册购买API</a>'}
                            <span class="zhs-info" id="infoIcon" title="">ℹ️ 使用说明</span>
                            <span style="margin-left:auto">最新版：<span id="latestVersion">检测中</span></span>
                        </div>
                    </div>
                </details>
            </div>
        `;
        return element;
    }

    function renderModelDropdown() {
        const optionsEl = document.getElementById('modelDropdownOptions');
        if (!optionsEl) return;
        const defaults = getDefaultModels();
        const allModels = getAllModels();
        optionsEl.innerHTML = `
            ${allModels.map(model => `
                <div class="zhs-dropdown-item" data-model="${model}">
                    <span>${model}</span>
                    ${defaults.includes(model) ? '' : '<span class="zhs-remove-model" data-model="' + model + '">×</span>'}
                </div>
            `).join('')}
            <div class="zhs-add-model">
                <input type="text" id="newModelInput" placeholder="输入模型名称">
                <button class="zhs-mini-btn blue" id="saveModelButton">保存</button>
            </div>
        `;
    }

    function updatePanel() {
        const panel = document.getElementById('zhsPanel');
        if (!panel) return;

        const mode = GM_getValue("workMode", "answer");
        const answerTarget = GM_getValue("answerTarget", 50);
        const askTarget = GM_getValue("askTarget", 10);

        panel.querySelectorAll('.zhs-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        const reached = isTargetReached();
        const statusEl = panel.querySelector('#zhsStatus');
        const dotEl = panel.querySelector('#zhsDot');
        const toggleBtn = panel.querySelector('#zhsToggleBtn');

        if (reached) {
            statusEl.textContent = mode === 'answer' ? '回答目标已达成 ✓' : '提问目标已达成 ✓';
            dotEl.className = 'zhs-dot done';
            toggleBtn.textContent = '继续';
        } else if (waitingForChild) {
            statusEl.textContent = '等待子页面回答…';
            dotEl.className = 'zhs-dot paused';
            toggleBtn.textContent = '暂停';
        } else {
            statusEl.textContent = countdownInterval ? '运行中' : '已暂停';
            dotEl.className = 'zhs-dot' + (countdownInterval ? '' : ' paused');
            toggleBtn.textContent = countdownInterval ? '暂停' : '继续';
        }

        const progressText = panel.querySelector('#zhsProgressText');
        const progressSub = panel.querySelector('#zhsProgressSub');
        const progressFill = panel.querySelector('#zhsProgressFill');
        const official = readOfficialCounts();
        if (mode === 'answer') {
            const total = Object.keys(GM_getValue("questionsData", {})[getCurrentCourse()] || {}).length;
            const internal = getAnsweredCount();
            const count = official.answer !== null ? official.answer : internal;
            progressText.textContent = `已答 ${count} / ${answerTarget}`;
            progressSub.textContent = (official.answer !== null ? `页面官方 ${official.answer} · ` : '') + `脚本计数 ${getScriptAnsweredCount()} · 列表共 ${total} 题`;
            progressFill.style.width = Math.min(100, count / answerTarget * 100) + '%';
        } else {
            const internal = getAskedList().length;
            const count = official.asked !== null ? official.asked : internal;
            progressText.textContent = `已提问 ${count} / ${askTarget}`;
            progressSub.textContent = (official.asked !== null ? `页面官方 ${official.asked} · ` : '') + `课程：${getCurrentCourse()}`;
            progressFill.style.width = Math.min(100, count / askTarget * 100) + '%';
        }

        const savedCountdown = GM_getValue("currentCountdown", null);
        const cdEl = panel.querySelector('#zhsCountdown');
        if (cdEl && savedCountdown !== null) cdEl.textContent = waitingForChild ? '--' : savedCountdown;

        const scrollBtn = panel.querySelector('#zhsScrollBtn');
        if (scrollBtn) scrollBtn.classList.toggle('on', GM_getValue("isAutoScrolling", false));
    }

    let restoreRetryTimer = null; // “回归位置”按钮的异步重试定时器

    // 面板一进页面就创建，不等“我参与的”等任何异步区块
    function ensurePanel() {
        if (!document.body) return;
        let panel = document.getElementById('zhsPanel');
        if (!panel) {
            injectStyles();
            panel = createPanel();
            document.body.appendChild(panel);
            setupPanelEvents(panel);
            checkForLatestVersion();
        }
        // “手机参与问答”区块是异步渲染的，回归按钮插不上就每秒重试（最多 60 秒）
        if (!document.getElementById('zhsRestoreBtn') && !restoreRetryTimer) {
            ensureRestoreButton();
            restoreRetryTimer = setInterval(() => {
                ensureRestoreButton();
                if (document.getElementById('zhsRestoreBtn')) {
                    clearInterval(restoreRetryTimer);
                    restoreRetryTimer = null;
                }
            }, 1000);
            setTimeout(() => {
                if (restoreRetryTimer) {
                    clearInterval(restoreRetryTimer);
                    restoreRetryTimer = null;
                }
            }, 60000);
        }
        updatePanel();
    }

    // 面板确保（带重试）：“我参与的”栏目是异步渲染的，达标暂停等
    // 不走倒计时的路径也必须能把面板显示出来供用户控制
    function ensurePanelWithRetry(maxTries = 20) {
        ensurePanel();
        let tries = 0;
        const t = setInterval(() => {
            ensurePanel();
            if (document.getElementById('zhsPanel') || ++tries >= maxTries) {
                clearInterval(t);
            }
        }, 500);
    }

    /* ---------- “回归位置”按钮：把悬浮面板召唤回按钮旁边 ---------- */

    function ensureRestoreButton() {
        if (document.getElementById('zhsRestoreBtn')) return;
        const qrCodeDiv = document.querySelector('.QRcode-div');
        if (!qrCodeDiv || !qrCodeDiv.parentNode) return;
        injectStyles();

        const btn = document.createElement('button');
        btn.id = 'zhsRestoreBtn';
        btn.className = 'zhs-restore-btn';
        btn.textContent = '📌 自动化助手回归位置';
        btn.addEventListener('click', () => {
            ensurePanel();
            const panel = document.getElementById('zhsPanel');
            if (!panel) {
                showAlert('面板尚未加载，请稍后重试');
                return;
            }
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                GM_setValue("panelCollapsed", false);
                const cb = panel.querySelector('#zhsCollapseBtn');
                if (cb) cb.textContent = '—';
            }
            const r = btn.getBoundingClientRect();
            const pw = panel.offsetWidth;
            let left = r.left - pw - 12;
            let top = r.top;
            left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
            top = Math.max(8, Math.min(window.innerHeight - 120, top));
            panel.style.right = 'auto';
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            GM_setValue("panelPos", { left: panel.style.left, top: panel.style.top });
            showAlert('面板已回到此处');
        });

        qrCodeDiv.parentNode.insertBefore(btn, qrCodeDiv.nextSibling);
    }

    function setupPanelEvents(panel) {
        // 折叠
        panel.querySelector('#zhsCollapseBtn').addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            GM_setValue("panelCollapsed", collapsed);
            panel.querySelector('#zhsCollapseBtn').textContent = collapsed ? '▢' : '—';
        });
        if (GM_getValue("panelCollapsed", false)) {
            panel.querySelector('#zhsCollapseBtn').textContent = '▢';
        }

        // 拖拽
        const header = panel.querySelector('.zhs-header');
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect();
            sl = r.left; st = r.top;
            panel.style.right = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            let nl = sl + e.clientX - sx;
            let nt = st + e.clientY - sy;
            nl = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, nl));
            nt = Math.max(0, Math.min(window.innerHeight - 44, nt));
            panel.style.left = nl + 'px';
            panel.style.top = nt + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            GM_setValue("panelPos", { left: panel.style.left, top: panel.style.top });
        });

        const savedPos = GM_getValue("panelPos", null);
        if (savedPos) {
            panel.style.right = 'auto';
            panel.style.left = savedPos.left;
            panel.style.top = savedPos.top;
            // 防止历史保存的位置已超出当前窗口可视范围（换窗口/缩放后会找不到面板）
            requestAnimationFrame(() => {
                const r = panel.getBoundingClientRect();
                if (r.left > window.innerWidth - 60 || r.right < 60 ||
                    r.top > window.innerHeight - 40 || r.bottom < 40) {
                    panel.style.left = 'auto';
                    panel.style.right = '24px';
                    panel.style.top = '90px';
                    GM_setValue("panelPos", null);
                    console.log('面板历史位置已超出可视范围，已重置到默认位置。');
                }
            });
        }

        // 模式切换
        panel.querySelectorAll('.zhs-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                GM_setValue("workMode", mode);
                resetStagnation();
                cancelChildWait();
                showAlert(mode === 'answer' ? '已切换到回答模式' : '已切换到提问模式（全自动AI提问）');
                startCountdown();
                updatePanel();
            });
        });

        // 暂停/继续
        panel.querySelector('#zhsToggleBtn').addEventListener('click', () => {
            // 等待子页面期间点暂停 = 取消等待，不自动恢复（子页面仍会自己答完关闭）
            if (waitingForChild) {
                cancelChildWait();
                showAlert("已暂停（不再等待子页面）");
                updatePanel();
                return;
            }
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                showAlert("已暂停");
            } else {
                const savedCountdown = GM_getValue("currentCountdown", GM_getValue("countdownTime", initialCountdownTime));
                startCountdown(savedCountdown);
                showAlert("已继续");
            }
            updatePanel();
        });

        panel.querySelector('#zhsJumpBtn').addEventListener('click', () => {
            scrollToLastUnansweredQuestion();
        });

        panel.querySelector('#zhsScrollBtn').addEventListener('click', () => {
            const isAutoScrolling = GM_getValue("isAutoScrolling", false);
            GM_setValue("isAutoScrolling", !isAutoScrolling);
            showAlert(isAutoScrolling ? "自动滚动已关闭" : "自动滚动已开启，将持续滚动未答题目到最上方");
            if (!isAutoScrolling) scrollToLastUnansweredQuestion();
            updatePanel();
        });

        // 强制下一题：跳过倒计时，立即执行当前模式的下一轮动作
        panel.querySelector('#zhsNextBtn').addEventListener('click', () => {
            cancelChildWait();
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            showAlert("强制进入下一题");
            onWorkTick();
            updatePanel();
        });

        // 同步官方“我的回答”：不逐个点题就知道哪些已回答过
        panel.querySelector('#zhsSyncBtn').addEventListener('click', () => {
            if (syncingAnswered) {
                showAlert("正在同步中，请稍候...");
                return;
            }
            cancelChildWait();
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            showAlert("正在读取官方回答记录...");
            const courseName = (document.querySelector(".course-name") || {}).innerText?.trim() || "";
            syncAnsweredFromMyJoin(courseName, () => {
                checkCountConsistency();
                startCountdown();
                updatePanel();
            });
        });

        panel.querySelector('#zhsManageBtn').addEventListener('click', createQuestionManagementModal);

        // 设置回填
        panel.querySelector('#apiKeyInput').value = GM_getValue("API_KEY", defaultAPIKey);
        panel.querySelector('#apiUrlInput').value = GM_getValue("API_URL", defaultAPIUrl);
        panel.querySelector('#answerTargetInput').value = GM_getValue("answerTarget", 50);
        panel.querySelector('#askTargetInput').value = GM_getValue("askTarget", 10);
        panel.querySelector('#stagnantLimitInput').value = GM_getValue("stagnantLimit", 5);
        panel.querySelector('#useOfficialDataInput').checked = GM_getValue("useOfficialData", false);

        // 模型下拉
        renderModelDropdown();
        const dropdown = panel.querySelector('#modelDropdown');
        const dropdownSelected = panel.querySelector('#modelDropdownSelected');
        const dropdownOptions = panel.querySelector('#modelDropdownOptions');

        dropdownSelected.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdownOptions.style.display = dropdownOptions.style.display === 'block' ? 'none' : 'block';
        });
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target)) dropdownOptions.style.display = 'none';
        });
        dropdownOptions.addEventListener('click', (e) => {
            const item = e.target.closest('.zhs-dropdown-item');
            const remove = e.target.closest('.zhs-remove-model');
            if (remove) {
                const modelToRemove = remove.dataset.model;
                let customModels = GM_getValue("customModels", []);
                customModels = customModels.filter(m => m !== modelToRemove);
                GM_setValue("customModels", customModels);
                renderModelDropdown();
                return;
            }
            if (item) {
                GM_setValue("aimodel", item.dataset.model);
                dropdownSelected.textContent = item.dataset.model;
                dropdownOptions.style.display = 'none';
                return;
            }
            if (e.target.closest('#saveModelButton')) {
                const input = dropdownOptions.querySelector('#newModelInput');
                const newModel = input.value.trim();
                if (newModel && !getAllModels().includes(newModel)) {
                    let customModels = GM_getValue("customModels", []);
                    customModels.push(newModel);
                    GM_setValue("customModels", customModels);
                    renderModelDropdown();
                    dropdownOptions.style.display = 'block';
                }
            }
        });

        // 保存设置
        panel.querySelector('#zhsSaveBtn').addEventListener('click', () => {
            GM_setValue("API_KEY", panel.querySelector('#apiKeyInput').value);
            GM_setValue("API_URL", panel.querySelector('#apiUrlInput').value);
            GM_setValue("answerTarget", parseInt(panel.querySelector('#answerTargetInput').value) || 50);
            GM_setValue("askTarget", parseInt(panel.querySelector('#askTargetInput').value) || 10);
            GM_setValue("stagnantLimit", parseInt(panel.querySelector('#stagnantLimitInput').value) || 5);
            GM_setValue("useOfficialData", panel.querySelector('#useOfficialDataInput').checked);
            showAlert("设置已保存");
            updatePanel();
        });

        // 购买链接
        const purchaseLink = panel.querySelector('#purchaseLink');
        if (purchaseLink) {
            purchaseLink.addEventListener('click', (e) => {
                e.preventDefault();
                GM_setValue("linkClicked", true);
                purchaseLink.style.display = 'none';
                window.open("https://api.v3.cm/register?aff=25L7", "_blank");
            });
        }

        // 信息提示
        const infoIcon = panel.querySelector('#infoIcon');
        let tooltip = null;
        const showTooltip = () => {
            if (tooltip) return;
            tooltip = document.createElement('div');
            tooltip.className = 'zhs-tooltip';
            tooltip.innerText = `1. 打开问答页先自动检查"我参与的"官方回答/提问数：已达标则脚本不运行，未达标才开始刷。\n2. 进入后先同步官方"我的回答"记录，然后固定 5 秒倒计时，答一题等一题。\n3. 默认目标：回答 50 条、提问 10 条，可在设置中修改。\n4. 答题太快会被禁言，5 秒间隔已较激进；若被风控请暂停休息一段时间再用。\n5. 不要一天刷几百条。\n6. 面板标题栏可拖拽移动位置，点击"—"可折叠。`;
            document.body.appendChild(tooltip);
            const r = infoIcon.getBoundingClientRect();
            tooltip.style.left = Math.max(8, r.left - 250) + 'px';
            tooltip.style.top = (r.bottom + 8) + 'px';
        };
        const hideTooltip = () => {
            if (tooltip) { tooltip.remove(); tooltip = null; }
        };
        infoIcon.addEventListener('mouseenter', showTooltip);
        infoIcon.addEventListener('mouseleave', hideTooltip);
    }

    /* ==================== 问题管理弹窗 ==================== */

    function createQuestionManagementModal() {
        const existing = document.querySelector('.question-management-modal');
        if (existing) existing.remove();
        injectStyles();

        const modal = document.createElement('div');
        modal.className = 'question-management-modal';

        let questionsData = GM_getValue("questionsData", {});
        const lastViewedCourseIndex = GM_getValue("lastViewedCourseIndex", 0);
        let questionsPerPage = GM_getValue("questionsPerPage", 10);

        const coursetabs = document.createElement('div');
        coursetabs.className = 'zhs-modal-tabs';

        const contentArea = document.createElement('div');
        contentArea.className = 'zhs-modal-content';

        Object.keys(questionsData).forEach((courseName, index) => {
            const courseTab = document.createElement('div');
            courseTab.className = 'zhs-modal-tab' + (index === lastViewedCourseIndex ? ' active' : '');
            courseTab.textContent = courseName;

            const courseTable = document.createElement('div');
            courseTable.style.cssText = `display:${index === lastViewedCourseIndex ? 'flex' : 'none'};flex-direction:column;flex:1;overflow:hidden;`;

            const tableContainer = document.createElement('div');
            tableContainer.className = 'zhs-modal-tablewrap';

            const table = document.createElement('table');
            table.className = 'zhs-modal-table';

            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr>
                    <th style="width:62%;">题目
                        <input type="text" placeholder="搜索..." class="zhs-modal-search filter-input">
                    </th>
                    <th style="width:18%;text-align:center;">状态</th>
                    <th style="width:20%;text-align:center;">操作</th>
                </tr>
            `;

            const tbody = document.createElement('tbody');

            let questions = Object.entries(questionsData[courseName]);
            let currentPage = GM_getValue(`lastViewedPage_${courseName}`, 1);
            let totalPages = Math.ceil(questions.length / questionsPerPage);
            let isSearchMode = false;

            function displayQuestions(page, filteredQuestions = null) {
                tbody.innerHTML = '';
                const questionsToDisplay = filteredQuestions || questions;
                const startIndex = (page - 1) * questionsPerPage;
                const endIndex = Math.min(startIndex + questionsPerPage, questionsToDisplay.length);

                for (let i = startIndex; i < endIndex; i++) {
                    const [question, status] = questionsToDisplay[i];
                    const questionIndex = questions.findIndex(([q]) => q === question);
                    const questionPage = Math.ceil((questionIndex + 1) / questionsPerPage);

                    const row = document.createElement('tr');
                    row.setAttribute('data-question', question);
                    let questionHTML = question;
                    if (isSearchMode && filteredQuestions) {
                        questionHTML += ` <span style="color:#f59e0b;">(第${questionPage}页)</span>`;
                    }
                    row.innerHTML = `
                        <td>${questionHTML}</td>
                        <td style="text-align:center;" class="${status === '已回答' ? 'zhs-tag-ok' : (status === '无法回答' ? 'zhs-tag-na' : 'zhs-tag-no')}">${status}</td>
                        <td style="text-align:center;">
                            <button class="set-answered zhs-mini-btn ok" data-course="${courseName}" data-question="${question}">设为已答</button>
                            <button class="set-unanswered zhs-mini-btn no" data-course="${courseName}" data-question="${question}">设为未答</button>
                        </td>
                    `;
                    tbody.appendChild(row);
                }
            }

            displayQuestions(currentPage);

            thead.querySelector('.filter-input').addEventListener('input', function () {
                const filterValue = this.value.toLowerCase();
                isSearchMode = filterValue.length > 0;
                const filteredQuestions = Object.entries(questionsData[courseName]).filter(([question]) => {
                    return question.toLowerCase().includes(filterValue);
                });
                totalPages = Math.max(1, Math.ceil(filteredQuestions.length / questionsPerPage));
                currentPage = 1;
                displayQuestions(currentPage, filteredQuestions);
                updatePagination();
            });

            table.addEventListener('click', function (event) {
                const target = event.target;
                const course = target.dataset.course;
                const question = target.dataset.question;
                if (!course || !question) return;

                const data = GM_getValue("questionsData", {});

                if (target.classList.contains('set-answered')) {
                    data[course][question] = '已回答';
                    GM_setValue("questionsData", data);
                    refreshQuestionManagementModal(course, currentPage);
                }

                if (target.classList.contains('set-unanswered')) {
                    data[course][question] = '未回答';
                    GM_setValue("questionsData", data);
                    refreshQuestionManagementModal(course, currentPage);
                }
            });

            table.appendChild(thead);
            table.appendChild(tbody);
            tableContainer.appendChild(table);
            courseTable.appendChild(tableContainer);

            courseTab.addEventListener('click', () => {
                Array.from(coursetabs.children).forEach((tab, idx) => {
                    tab.classList.remove('active');
                    contentArea.children[idx].style.display = 'none';
                });

                courseTab.classList.add('active');
                courseTable.style.display = 'flex';
                GM_setValue("lastViewedCourseIndex", index);
                currentPage = GM_getValue(`lastViewedPage_${courseName}`, 1);
                displayQuestions(currentPage);
                updatePagination();
                isSearchMode = false;
            });

            coursetabs.appendChild(courseTab);
            contentArea.appendChild(courseTable);

            const footer = document.createElement('div');
            footer.className = 'zhs-modal-footer';

            const leftGroup = document.createElement('div');
            leftGroup.className = 'group';

            const questionsPerPageLabel = document.createElement('span');
            questionsPerPageLabel.textContent = '每页显示:';
            questionsPerPageLabel.style.color = '#8b94a5';

            const questionsPerPageInput = document.createElement('input');
            questionsPerPageInput.type = 'number';
            questionsPerPageInput.value = questionsPerPage;

            const saveButton = document.createElement('button');
            saveButton.className = 'zhs-mini-btn blue';
            saveButton.textContent = '保存';
            saveButton.addEventListener('click', () => {
                const newQuestionsPerPage = parseInt(questionsPerPageInput.value);
                if (!isNaN(newQuestionsPerPage) && newQuestionsPerPage > 0) {
                    GM_setValue("questionsPerPage", newQuestionsPerPage);
                    questionsPerPage = newQuestionsPerPage;
                    totalPages = Math.ceil(Object.keys(questionsData[courseName]).length / questionsPerPage);
                    displayQuestions(currentPage);
                    updatePagination();
                } else {
                    showAlert('请输入有效的每页显示数量');
                    questionsPerPageInput.value = questionsPerPage;
                }
            });

            const setPageAnsweredButton = document.createElement('button');
            setPageAnsweredButton.className = 'zhs-mini-btn ok';
            setPageAnsweredButton.textContent = '一键本页已答';
            setPageAnsweredButton.addEventListener('click', () => {
                setQuestionsStatusForCurrentPage(courseName, '已回答', currentPage, questionsPerPage);
                refreshQuestionManagementModal(courseName, currentPage);
            });

            const setPageUnansweredButton = document.createElement('button');
            setPageUnansweredButton.className = 'zhs-mini-btn no';
            setPageUnansweredButton.textContent = '一键本页未答';
            setPageUnansweredButton.addEventListener('click', () => {
                setQuestionsStatusForCurrentPage(courseName, '未回答', currentPage, questionsPerPage);
                refreshQuestionManagementModal(courseName, currentPage);
            });

            leftGroup.appendChild(questionsPerPageLabel);
            leftGroup.appendChild(questionsPerPageInput);
            leftGroup.appendChild(saveButton);
            leftGroup.appendChild(setPageAnsweredButton);
            leftGroup.appendChild(setPageUnansweredButton);

            const midGroup = document.createElement('div');
            midGroup.className = 'group';

            const prevButton = document.createElement('button');
            prevButton.className = 'zhs-mini-btn gray';
            prevButton.textContent = '上一页';
            prevButton.addEventListener('click', () => {
                if (currentPage > 1) {
                    currentPage--;
                    GM_setValue(`lastViewedPage_${courseName}`, currentPage);
                    displayQuestions(currentPage);
                    updatePagination();
                }
            });

            const pageInfo = document.createElement('span');
            pageInfo.className = 'zhs-modal-pageinfo';

            const nextButton = document.createElement('button');
            nextButton.className = 'zhs-mini-btn gray';
            nextButton.textContent = '下一页';
            nextButton.addEventListener('click', () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    GM_setValue(`lastViewedPage_${courseName}`, currentPage);
                    displayQuestions(currentPage);
                    updatePagination();
                }
            });

            midGroup.appendChild(prevButton);
            midGroup.appendChild(pageInfo);
            midGroup.appendChild(nextButton);

            const rightGroup = document.createElement('div');
            rightGroup.className = 'group';

            const gotoPageInput = document.createElement('input');
            gotoPageInput.type = 'number';
            gotoPageInput.placeholder = '页码';

            const gotoPageButton = document.createElement('button');
            gotoPageButton.className = 'zhs-mini-btn blue';
            gotoPageButton.textContent = '跳转';
            gotoPageButton.addEventListener('click', () => {
                const pageNumber = parseInt(gotoPageInput.value);
                if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages) {
                    currentPage = pageNumber;
                    GM_setValue(`lastViewedPage_${courseName}`, currentPage);
                    displayQuestions(currentPage);
                    updatePagination();
                } else {
                    showAlert('请输入有效的页码');
                    gotoPageInput.value = '';
                }
            });

            rightGroup.appendChild(gotoPageInput);
            rightGroup.appendChild(gotoPageButton);

            function updatePagination() {
                pageInfo.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页`;
            }

            updatePagination();

            footer.appendChild(leftGroup);
            footer.appendChild(midGroup);
            footer.appendChild(rightGroup);

            courseTable.appendChild(footer);

            currentPage = GM_getValue(`lastViewedPage_${courseName}`, 1);
            displayQuestions(currentPage);
            updatePagination();
        });

        const closeButton = document.createElement('button');
        closeButton.className = 'zhs-modal-close';
        closeButton.textContent = '✕';
        closeButton.addEventListener('click', () => modal.remove());

        modal.appendChild(coursetabs);
        modal.appendChild(contentArea);
        modal.appendChild(closeButton);

        document.body.appendChild(modal);
    }

    function setQuestionsStatusForCurrentPage(courseName, status, currentPage, questionsPerPage) {
        let questionsData = GM_getValue("questionsData", {});
        if (questionsData[courseName]) {
            const questions = Object.keys(questionsData[courseName]);
            const startIndex = (currentPage - 1) * questionsPerPage;
            const endIndex = Math.min(startIndex + questionsPerPage, questions.length);

            for (let i = startIndex; i < endIndex; i++) {
                questionsData[courseName][questions[i]] = status;
            }
            GM_setValue("questionsData", questionsData);
        }
    }

    function refreshQuestionManagementModal(courseName, currentPage) {
        GM_setValue(`lastViewedPage_${courseName}`, currentPage);
        createQuestionManagementModal();
        updatePanel();
    }

    /* ==================== 工作模式引擎 ==================== */

    function pauseForTarget(message) {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        // 达标暂停时也必须把面板显示出来供用户控制（面板原本只在倒计时启动时创建）
        ensurePanelWithRetry();
        showAlert(message);
        console.log(message);
        updatePanel();
    }

    let lastCaptchaAlertTime = 0;
    let loadingMore = false;   // 正在下拉加载更多题目
    let noMoreAlerted = false; // "没有更多题"只提醒一次

    // 当前批次全部答完：把列表滚到底部，触发无限滚动加载下一批题目
    function loadMoreQuestions() {
        if (loadingMore) return;
        const scrollContainer = document.querySelector('.el-scrollbar__wrap');
        if (!scrollContainer) {
            console.log('未找到列表滚动容器，稍后重试');
            startCountdown();
            return;
        }
        loadingMore = true;
        const before = document.querySelectorAll('.question-item').length;
        console.log(`当前列表 ${before} 题均已处理，滚动到底部加载更多…`);
        parentLog(`列表 ${before} 题已处理完，正在下拉加载更多…`);
        // 立即跳到底部（不用平滑滚动，长列表平滑滚动太慢且可能不触发加载）
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

        const t0 = Date.now();
        const timer = setInterval(() => {
            const now = document.querySelectorAll('.question-item').length;
            if (now > before || Date.now() - t0 > 12000) {
                clearInterval(timer);
                loadingMore = false;
                if (now > before) {
                    noMoreAlerted = false;
                    showAlert(`已加载新题目（现共 ${now} 题），继续答题`);
                    parentLog(`加载完成，新增 ${now - before} 题，共 ${now} 题`);
                    checkHomeRegex(); // 立即登记新题为"未回答"
                    onWorkTick();     // 直接继续，不等多余倒计时
                } else {
                    if (!noMoreAlerted) {
                        noMoreAlerted = true;
                        showAlert('已滚到底部，没有更多题目了');
                    }
                    parentLog('没有更多题目，保持等待');
                    startCountdown(); // 保持节奏；以后来了新题还能继续
                }
            }
        }, 500);
    }

    function onWorkTick() {
        // 同步官方回答记录期间暂停一切工作
        if (syncingAnswered) {
            console.log("正在同步官方回答记录，本轮跳过");
            return;
        }
        // 正在加载更多题目：等加载结果，不重复触发
        if (loadingMore) {
            console.log("正在加载更多题目，本轮跳过");
            return;
        }
        // 正在等待子页面回答本题：不启动任何新动作，直到收到汇报或超时
        if (waitingForChild) {
            console.log("正在等待子页面回答，跳过本轮");
            return;
        }
        const mode = GM_getValue("workMode", "answer");

        // 页面存在安全验证二维码时，暂停本轮工作，等验证完再继续
        if (document.querySelector(".yidun_modal")) {
            console.log("检测到安全验证二维码，本轮暂停，等待人工验证...");
            const now = Date.now();
            if (now - lastCaptchaAlertTime > 60000) {
                lastCaptchaAlertTime = now;
                showAlert("检测到二维码，请验证；验证后脚本自动继续");
            }
            startCountdown();
            return;
        }

        if (isTargetReached()) {
            pauseForTarget(mode === "answer"
                ? "回答目标已达成，脚本已自动暂停"
                : "提问目标已达成，脚本已自动暂停");
            return;
        }
        // 先作答、后比对：与上一次作答前的官方数字对比，连续 N 次无变化才刷新
        // （仅开启“官方数据统计”实验功能时启用，默认关闭）
        if (GM_getValue("useOfficialData", false)) {
            const current = getOfficialProgress();
            if (current !== null && baselineOfficial !== null && current === baselineOfficial) {
                workAttemptsSinceChange++;
                const limit = Math.max(2, GM_getValue("stagnantLimit", 5));
                if (workAttemptsSinceChange >= limit) {
                    workAttemptsSinceChange = 0;
                    showAlert("已连续多次作答但官方数据无变化，2 秒后刷新页面重试...");
                    console.log("连续多次作答官方数据无变化，刷新页面");
                    setTimeout(() => location.reload(), 2000);
                    return;
                }
            } else {
                workAttemptsSinceChange = 0;
            }
            if (current !== null) baselineOfficial = current;
        }

        if (mode === "answer") {
            const opened = clickTheUnansweredLink();
            if (opened) {
                // 已唤起子页面：父页面挂起等待汇报，收到结果后再开始下一轮倒计时
                beginChildWait();
            } else {
                // 当前批次没有未答题：把列表滚到底部，触发无限滚动加载下一批题目
                loadMoreQuestions();
            }
        } else {
            runAskCycle();
        }
    }

    function startCountdown(restartCount = null) {
        if (countdownInterval) {
            clearInterval(countdownInterval);
        }

        // 倒计时固定 5 秒（按需求不再允许用户调节间隔）
        let countdown = restartCount !== null ? restartCount : 5;
        GM_setValue("countdownTime", countdown);
        GM_setValue("currentCountdown", countdown);
        ensurePanel();

        countdownInterval = setInterval(() => {
            countdown--;
            GM_setValue("currentCountdown", countdown);
            ensurePanel();
            handleChildReport(); // 兜底：轮询子页面汇报（监听不可用时也能收到）
            if (countdown <= 0) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                console.log(`${GM_getValue("countdownTime", initialCountdownTime)}秒已过，触发工作动作。`);
                onWorkTick();
            }
        }, 1000);
    }

    function openQuestionInNewTab(span) {
        // 页面通过 window.open 打开详情页，但脚本合成的 click 属于非用户手势，
        // 会被浏览器弹窗拦截；这里临时截获 open 的目标地址，改用 GM_openInTab 打开（不受拦截）
        const origOpen = window.open;
        let targetUrl = null;
        window.open = function (url) {
            targetUrl = url;
            console.log('截获详情页地址:', url);
            return { focus() { }, close() { }, closed: false, location: {} };
        };
        try {
            span.click();
        } finally {
            window.open = origOpen;
        }
        if (targetUrl) {
            GM_openInTab(targetUrl, { active: false });
        } else {
            console.log('未能截获详情页地址');
        }
    }

    function closeDetailWindow() {
        window.close();
        // GM_openInTab 打开的标签页不允许脚本关闭时，自动退回课程问答首页，避免标签堆积
        setTimeout(() => {
            try {
                // 标记本标签曾是子页面：万一退回首页，优先尝试再次关闭自己，
                // 避免变成第二个父页面并行跑回答
                sessionStorage.setItem('zhsWasChild', '1');
                location.href = location.href.replace(/#\/web\/questionDetail\/(\d+)\/\d+/, '#/web/home/$1');
            } catch (e) { /* 页面已关闭则不会执行到这里 */ }
        }, 800);
    }

    function clickTheUnansweredLink() {
        const questionItems = document.querySelectorAll('.question-item');
        const unansweredQuestions = Array.from(questionItems).filter(item => {
            const spanElement = item.querySelector('.question-content span');
            const questionText = spanElement ? spanElement.title.trim() : '';
            const courseNameElement = document.querySelector(".course-name");
            const courseName = courseNameElement ? courseNameElement.innerText.trim() : '';
            const status = GM_getValue("questionsData", {})[courseName]?.[questionText];
            return status === "未回答";
        });

        if (unansweredQuestions.length > 0) {
            const firstUnansweredQuestionSpan = unansweredQuestions[0].querySelector('.question-content span');

            if (firstUnansweredQuestionSpan) {
                openQuestionInNewTab(firstUnansweredQuestionSpan);
                console.log(`已点击第一个未回答的问题: ${firstUnansweredQuestionSpan.title}`);
                return true;
            } else {
                console.log("未找到未回答问题的链接元素");
            }
        } else {
            console.log("目前无未回答问题.");
        }
        return false;
    }

    /* ---------- 提问模式（全自动） ---------- */

    function recordAsked(question) {
        const course = getCurrentCourse();
        let asked = GM_getValue("askedQuestions", {});
        if (!asked[course]) asked[course] = [];
        if (!asked[course].includes(question)) asked[course].push(question);
        GM_setValue("askedQuestions", asked);
    }

    function findAskEntry() {
        // 优先使用页面右下角的“提问”图标按钮（div.ask-btn，无文字、title=提问）
        const askBtn = document.querySelector('div.ask-btn[title="提问"]') || document.querySelector('div.ask-btn');
        if (askBtn) return askBtn;
        // 兜底：按文字查找
        const leaves = document.querySelectorAll('span, div, button, a');
        for (const el of leaves) {
            if (el.closest('#zhsPanel') || el.closest(ASK_DIALOG_SELECTOR)) continue;
            if (el.children.length > 1) continue;
            const text = el.textContent.trim().replace(/\s+/g, '');
            if (text === '提问' || text === '我要提问' || text === '提个问题') {
                return el;
            }
        }
        return null;
    }

    function runAskCycle() {
        if (askLock) {
            startCountdown();
            return;
        }
        if (isTargetReached()) {
            pauseForTarget("提问目标已达成，脚本已自动暂停");
            return;
        }

        askLock = true;
        const entry = findAskEntry();
        if (!entry) {
            askLock = false;
            showAlert('未找到“提问”入口按钮，请确认在问答页面');
            startCountdown();
            return;
        }

        console.log('提问模式：点击提问入口...');
        entry.click();

        let tries = 0;
        const waitDialog = setInterval(() => {
            const dialog = document.querySelector(ASK_DIALOG_SELECTOR);
            if (dialog) {
                clearInterval(waitDialog);
                showAlert('正在通过 AI 生成问题...');
                generateQuestion(dialog, {
                    onSuccess: (question) => autoPublishQuestion(dialog, question),
                    onFail: () => {
                        askLock = false;
                        startCountdown();
                    }
                });
            } else if (++tries > 20) {
                clearInterval(waitDialog);
                askLock = false;
                showAlert('提问窗口未打开，本轮跳过');
                startCountdown();
            }
        }, 500);
    }

    function autoPublishQuestion(dialog, question) {
        let attempts = 0;
        const findBtn = setInterval(() => {
            const publishButton = dialog.querySelector('.dialog-bottom .up-btn');
            if (publishButton && publishButton.textContent.trim() === "立即发布") {
                clearInterval(findBtn);
                console.log('提问模式：点击“立即发布”，不等待结果，直接进入下一轮');
                publishButton.click();
                // 按本次提问尝试计数（用于达标暂停），不检测发布是否成功
                recordAsked(question);
                askLock = false;
                updatePanel();
                startCountdown();
            } else if (++attempts > 12) {
                clearInterval(findBtn);
                askLock = false;
                showAlert('未找到“立即发布”按钮，本轮跳过');
                startCountdown();
            }
        }, 600);
    }

    /* ==================== 页面问答流程（回答模式） ==================== */

    function checkHomeRegex() {
        const homePattern = /^https:\/\/qah5\.zhihuishu\.com\/qa\.html#\/web\/home/;
        const currentURL = window.location.href;

        if (homePattern.test(currentURL)) {
            console.log("正在获取问题列表...");

            const items = document.querySelectorAll(".question-item .question-content span");
            const courseNameElement = document.querySelector(".course-name");

            if (courseNameElement && items.length) {
                const courseName = courseNameElement.innerText.trim();
                let questionsData = GM_getValue("questionsData", {});

                if (!questionsData[courseName]) {
                    questionsData[courseName] = {};
                }

                items.forEach(item => {
                    const questionTitle = item.getAttribute("title").trim();
                    if (!questionsData[courseName][questionTitle]) {
                        questionsData[courseName][questionTitle] = "未回答";
                    }
                });

                GM_setValue("questionsData", questionsData);
                console.log("问题列表已更新:", questionsData);
            }
        }
    }

    function markQuestionAsAnswered(questionText) {
        const courseNameElement = document.querySelector(".course-name");
        if (courseNameElement) {
            const courseName = courseNameElement.innerText.trim();
            let questionsData = GM_getValue("questionsData", {});

            if (questionsData[courseName] && questionsData[courseName][questionText] === "未回答") {
                questionsData[courseName][questionText] = "已回答";
                GM_setValue("questionsData", questionsData);
                console.log(`问题“${questionText}”状态已更新为“已回答”。`);
            }
        }
    }

    function waitForAnswerButton() {
        if (GM_getValue("workMode", "answer") !== "answer") {
            console.log("当前为提问模式，跳过回答流程。");
            return;
        }

        const answerButton = document.querySelector("div.my-answer-btn.ZHIHUISHU_QZMD.tool-show span");

        if (answerButton && answerButton.textContent.trim() === "我来回答") {
            console.log("找到‘我来回答’按钮,点击...");
            ensureChildPanel();
            updateChildQuestion();
            setChildStatus('已点击“我来回答”，等待编辑器…', 'wait');
            childLog('找到“我来回答”按钮，点击');
            answerButton.click();
            noAnswerButtonCount = 0;

            setTimeout(() => {
                const inputElement = document.querySelector("textarea");
                if (inputElement) {
                    console.log("文本框已出现,准备回答问题...");
                    childLog('回答编辑器已就绪');
                    setChildStatus('编辑器就绪，准备调 AI 回答', 'run');
                    startChecking();
                } else {
                    console.log("文本框未出现,继续检测‘我来回答’按钮...");
                    waitForAnswerButton();
                }
            }, intervalTime);
        } else {
            checkHomeRegex();

            console.log("未找到‘我来回答’按钮或按钮状态不符合条件,稍后重试...");
            noAnswerButtonCount++;

            const currentURL = window.location.href;
            const pattern = /^https:\/\/qah5\.zhihuishu\.com\/qa\.html#\/web\/questionDetail\/\d+/;

            if (noAnswerButtonCount > 1) {
                if (pattern.test(currentURL)) {
                    const questionElement = document.querySelector(".question-content span");
                    const questionText = questionElement ? questionElement.innerText.trim() : '';
                    if (questionText) {
                        markQuestionAsAnswered(questionText);
                        // 子页面答完（或发现已答过）：向父页面汇报后关闭
                        if (isDetailPage()) {
                            reportToParent(questionText, "已回答（原本已答过，直接关闭）");
                        }
                        setChildStatus('本题此前已回答过，直接关闭', 'ok');
                        childLog('无需作答（此前已回答），关闭页面', 'ok');
                    }
                    console.log("当前页面符合特定模式，关闭网页...");
                    showAlert("答题完毕，准备关闭网页")
                    closeDetailWindow();
                } else {
                    console.log("当前页面不符合关闭条件，继续检测...");
                    noAnswerButtonCount = 0;
                }
            } else {
                setTimeout(waitForAnswerButton, intervalTime);
            }
        }
    }

    function addQuestionStatus() {
        const questionItems = document.querySelectorAll('.question-item');
        questionItems.forEach(item => {
            const spanElement = item.querySelector('.question-content span');
            const questionText = spanElement ? spanElement.title.trim() : '';
            if (questionText) {
                const courseNameElement = document.querySelector(".course-name");
                if (courseNameElement) {
                    const courseName = courseNameElement.innerText.trim();
                    let status = "未获取";
                    const questionsData = GM_getValue("questionsData", {});
                    if (questionsData[courseName] && questionsData[courseName][questionText]) {
                        status = questionsData[courseName][questionText];
                    }

                    const invalidPatterns = [
                        /什么是.+/, /.+是什么/, /.+是什么意思/, /.+的含义/, /指什么/, /是不是/, /对不对/, /好不好/, /好吗/, /近吗/, /远吗/, /对吗/,
                        /可以吗/, /可以.+吗/, /是否可以/, /有没有/, /能不能/, /应该.+吗/,
                        /是否应该/, /必须.+吗/, /是否必须/, /需要.+吗/, /是否需要/, /一定.+吗/,
                        /是否一定/, /是否合理/, /是否相同/, /是否不同/,
                        /有意义吗/, /意义大吗/, /喜欢.+吗/, /如何翻译.+/
                    ];

                    const isInvalidQuestion = invalidPatterns.some(pattern => pattern.test(questionText));

                    if (isInvalidQuestion && status !== "已回答") {
                        // 无效问题标为“无法回答”；但已回答过的题保持“已回答”，不降级
                        spanElement.style.textDecoration = 'line-through';
                        status = "无法回答";
                        questionsData[courseName] = questionsData[courseName] || {};
                        if (questionsData[courseName][questionText] !== "无法回答") {
                            questionsData[courseName][questionText] = "无法回答";
                            GM_setValue("questionsData", questionsData);
                        }
                    } else if (status === "未回答") {
                        spanElement.style.color = 'red';
                    } else if (status === "已回答") {
                        spanElement.style.color = 'green';
                    }
                }
            }
        });
    }

    /* ---------- 二维码（安全验证）处理：暂停等待人工验证，验证后自动继续 ---------- */

    let captchaHandling = false;

    function handleCaptcha() {
        if (captchaHandling) return;
        captchaHandling = true;

        console.log("检测到二维码，暂停等待人工验证...");
        GM_notification("检测到安全验证二维码，请尽快完成验证；验证后脚本会自动继续。", "安全验证");
        showAlert("检测到二维码，请手动验证，验证完成后自动继续答题");
        setChildStatus('检测到安全验证二维码，等待人工验证…', 'wait');
        childLog('检测到二维码，暂停等待人工验证', 'err');

        const startTime = Date.now();
        const MAX_WAIT = 5 * 60 * 1000; // 最长等待 5 分钟，超时后关闭窗口避免永久卡住

        const captchaCheck = setInterval(() => {
            if (!document.querySelector(".yidun_modal")) {
                clearInterval(captchaCheck);
                captchaHandling = false;
                console.log("二维码验证已完成，继续答题流程。");
                setChildStatus('验证完成，继续答题', 'run');
                childLog('验证完成，继续答题', 'ok');
                showAlert("验证完成，继续答题");
                return;
            }
            if (Date.now() - startTime > MAX_WAIT) {
                clearInterval(captchaCheck);
                captchaHandling = false;
                console.log("二维码验证超时，关闭当前窗口。");
                showAlert("验证超时，关闭窗口");
                closeDetailWindow();
            }
        }, 2000);
    }

    function startChecking() {
        setInterval(() => {
            console.log("检查问题和输入框是否存在...");

            const questionElement = document.querySelector(".question-content span");
            if (!questionElement) {
                console.log("未找到问题元素。");
                return;
            }

            const questionText = questionElement.innerText.trim();
            if (!questionText) {
                console.log("问题内容为空。");
                return;
            }

            updateChildQuestion();

            const inputElement = document.querySelector("textarea");
            if (!inputElement) {
                console.log("未找到输入框元素。");
                return;
            }

            addQuestionStatus();

            const answerButton = document.querySelector("div.my-answer-btn.ZHIHUISHU_QZMD.tool-show span");
            const modalExists = document.querySelector(".yidun_modal");
            if (modalExists) {
                handleCaptcha();
                return;
            }

            if (!answerButton || answerButton.textContent.trim() !== "我来回答") {
                const currentURL = window.location.href;
                const pattern = /^https:\/\/qah5\.zhihuishu\.com\/qa\.html#\/web\/questionDetail/;
                if (pattern.test(currentURL)) {
                    console.log("未找到'我来回答'按钮且当前页面符合特定模式,关闭当前窗口。");
                    markQuestionAsAnswered(questionText);
                    // 子页面回答完成：向父页面汇报后关闭
                    if (isDetailPage()) {
                        reportToParent(questionText, "已回答");
                    }
                    setChildStatus('回答完成，关闭页面', 'ok');
                    childLog('已标记为已回答，向父页面汇报后关闭页面', 'ok');
                    closeDetailWindow();
                } else {
                    console.log("未找到'我来回答'按钮且当前页面不符合特定模式,停止回答逻辑。");
                }
                return;
            }

            if (inputElement.value.trim() !== "") {
                console.log("输入框中已有数据,检查是否需要点击立即发布...");
                startPublishChecking();
                return;
            }

            console.log("找到问题并准备回答:", questionText);

            if (!requestLock) {
                requestLock = true;
                answerQuestion(questionText, inputElement);
                showAlert("正在回答问题")
            } else {
                console.log("请求进行中,跳过此次回答逻辑。");
                showAlert("正在回答问题");
            }


        }, intervalTime);
    }

    /* ==================== 提问弹窗（手动 + 自动共用） ==================== */

    function checkAndAddGenerateQuestionButton() {
        const dialog = document.querySelector(ASK_DIALOG_SELECTOR);
        if (dialog) {
            injectStyles();
            const publishButton = dialog.querySelector('.dialog-bottom .up-btn');
            if (publishButton) {
                if (!dialog.querySelector('#generateQuestionButton')) {
                    const generateQuestionButton = document.createElement('div');
                    generateQuestionButton.id = 'generateQuestionButton';
                    generateQuestionButton.className = 'zhs-gen-btn';
                    generateQuestionButton.textContent = '✨ AI 生成问题';

                    generateQuestionButton.addEventListener('click', () => {
                        generateQuestion(dialog);
                    });

                    const dialogBottom = publishButton.parentNode;
                    dialogBottom.style.display = 'flex';
                    dialogBottom.style.justifyContent = 'flex-end';

                    dialogBottom.insertBefore(generateQuestionButton, publishButton);
                }
            }
        }
    }

    const observer = new MutationObserver(checkAndAddGenerateQuestionButton);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
    });

    function generateQuestion(dialog, callbacks = {}) {
        const courseName = getCurrentCourse();

        const inputElement = dialog.querySelector('textarea');

        if (!inputElement) {
            showAlert('未找到提问输入框！');
            if (callbacks.onFail) callbacks.onFail();
            return;
        }

        const questionElements = document.querySelectorAll(".question-content.ZHIHUISHU_QZMD span");
        const recentQuestions = Array.from(questionElements)
            .map((element, index) => `${index + 1}. ${element.textContent.trim()}`)
            .slice(0, 20)
            .join("\n");

        const prompt = `针对${courseName}，请生成一个与以下30个问题**完全不同**的开放式问题，字数限制在50字以内。务必不同句式

                                    **以下是最近别人发送的1o个问题，请**务必避免句式重复或者句式相似**:
                                    ${recentQuestions} \n不要一直用"如何怎么样"的句式，你需要随便地提问，只要关于这个主题就行，发散思维。只回复你想到的问题即可，只需要回复一个问题即可，不要换行。`;

        console.log(prompt);

        showAlert(`正在生成问题...`)
        GM_xmlhttpRequest({
            method: "POST",
            url: GM_getValue("API_URL", defaultAPIUrl),
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GM_getValue("API_KEY", defaultAPIKey)}`
            },
            data: JSON.stringify({
                model: GM_getValue("aimodel", defaultModel),
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 10240,
                temperature: 1,
                top_p: 1,
                stream: false
            }),
            onload: function (response) {
                console.log("请求成功:", response.responseText);
                if (response.status === 200) {
                    try {
                        const jsonResponse = JSON.parse(response.responseText);
                        const generatedQuestion = jsonResponse.choices[0].message.content.trim();

                        inputElement.value = generatedQuestion;
                        inputElement.dispatchEvent(new Event('input', { 'bubbles': true }));
                        inputElement.dispatchEvent(new Event('change', { 'bubbles': true }));

                        showAlert('问题已生成并填充到提问框！');
                        if (callbacks.onSuccess) callbacks.onSuccess(generatedQuestion);
                    } catch (e) {
                        console.error("解析响应失败:", e);
                        showAlert("问题生成失败，API 响应格式异常。");
                        if (callbacks.onFail) callbacks.onFail();
                    }
                } else {
                    console.error("API 请求失败,状态码：", response.status);
                    showAlert("问题生成失败，请检查API设置或稍后重试。");
                    if (callbacks.onFail) callbacks.onFail();
                }
            },
            onerror: function () {
                console.error("API 请求出错。");
                showAlert("问题生成出错，请检查网络连接。");
                if (callbacks.onFail) callbacks.onFail();
            }
        });
    }

    function startPublishChecking() {
        console.log("检查是否需要点击立即发布按钮...");
        const publishButton = document.querySelector('.dialog-bottom .up-btn.ZHIHUISHU_QZMD.set-btn');

        const inputElement = document.querySelector('textarea');
        if (
            inputElement &&
            inputElement.value.trim() !== "" &&
            publishButton &&
            publishButton.textContent.trim() === "立即发布"
        ) {
            console.log("找到立即发布按钮,自动点击...");
            setChildStatus('点击“立即发布”…', 'wait');
            childLog('点击“立即发布”');
            publishButton.click();
        }
    }

    function answerQuestion(questionText, inputElement) {
        childLog('已向 AI 请求答案…');
        setChildStatus('等待 AI 回答…', 'wait');
        GM_xmlhttpRequest({
            method: "POST",
            url: GM_getValue("API_URL", defaultAPIUrl),
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GM_getValue("API_KEY", defaultAPIKey)}`
            },
            data: JSON.stringify({
                model: GM_getValue("aimodel", defaultModel),
                messages: [
                    {
                        role: "user",
                        content: `智慧树问题回答,你比如我提问：音乐剧与民歌在曲风、表现形式和情感表达上有何不同？如何在声乐演唱中体现这些差异？你只需要给出简介30字以内或者左右的回答即可。只需要输出回答,不需要其他,也不需要markdown格式，回答中严禁出现下面三个词连在一起：“学习通”。且回答至少超过10个字。问题如下：${questionText}`
                    }
                ],
                max_tokens: 1688,
                temperature: 0.5,
                stream: false
            }),
            onload: function (response) {
                requestLock = false;
                console.log("请求成功:", response.responseText);
                if (response.status === 200) {
                    const jsonResponse = JSON.parse(response.responseText);
                    const answer = jsonResponse.choices[0].message.content.trim();
                    console.log("获取到的回答：", answer);

                    inputElement.value = answer;
                    inputElement.dispatchEvent(inputEvent);
                    setChildStatus('答案已填入，准备发布', 'run');
                    childLog('AI 回答：' + (answer.length > 60 ? answer.slice(0, 60) + '…' : answer), 'ok');
                    showChildAnswer(answer);
                    showAlert("成功填入问题答案");
                } else {
                    console.error("API 请求失败,状态码：", response.status);
                    setChildStatus('AI 请求失败，稍后自动重试', 'err');
                    childLog('AI 请求失败（状态码 ' + response.status + '），下一轮重试', 'err');
                    showAlert("申请答题链接失败，请刷新网页或稍后再试。")
                }
            },
            onerror: function () {
                requestLock = false;
                console.error("API 请求出错。");
                setChildStatus('AI 请求出错，稍后自动重试', 'err');
                childLog('AI 请求出错（网络），下一轮重试', 'err');
            }
        });
    }

    /* ==================== 滚动 / 监听 / 版本 ==================== */

    let scrolling = false;

    function scrollToLastUnansweredQuestion() {
        // 提问模式不滚动列表、不等待新题目：提问是自己点“提问”按钮创建的
        if (GM_getValue("workMode", "answer") !== "answer") return;
        if (scrolling) {
            console.log("正在滚动，请稍后...");
            showAlert("正在滚动，请稍后...");
            return;
        }

        scrolling = true;

        let scrollContainer = document.querySelector('.el-scrollbar__wrap');
        if (!scrollContainer) {
            scrolling = false;
            return;
        }

        const questionItems = document.querySelectorAll('.question-item');
        const courseName = getCurrentCourse();
        const questionsData = GM_getValue("questionsData", {});

        function performScroll(targetElement) {
            const targetOffsetTop = targetElement.offsetTop;
            scrollContainer.scrollTo({
                top: targetOffsetTop,
                behavior: 'smooth'
            });

            const checkScrollInterval = setInterval(() => {
                const currentScrollTop = scrollContainer.scrollTop;
                const offsetDifference = Math.abs(currentScrollTop - targetOffsetTop);

                if (offsetDifference <= 5) {
                    console.log("滚动完成，位于目标位置！");
                    clearInterval(checkScrollInterval);
                    scrolling = false;
                } else {
                    console.log("滚动未完全到达目标位置，继续等待...");
                }
            }, 200);

            setTimeout(() => {
                clearInterval(checkScrollInterval);
                scrolling = false;
                console.log("滚动超时，停止检查。");
            }, 5000);
        }

        for (let i = 0; i < questionItems.length; i++) {
            const item = questionItems[i];
            const spanElement = item.querySelector('.question-content span');
            const questionText = spanElement ? spanElement.title.trim() : '';

            if (questionText && courseName && questionsData[courseName]) {
                const status = questionsData[courseName][questionText] || "未回答";

                const isExcluded = spanElement.style.textDecoration === 'line-through';

                if (status === "未回答" && !isExcluded) {
                    console.log(`找到第一个未回答且未排除的问题，索引: ${i}，问题内容: ${questionText}`);
                    performScroll(item);
                    return;
                }
            }
        }


        console.log("没有找到未回答且未排除的问题，滚动到最底部...");

        scrollContainer.scrollTo({
            top: scrollContainer.scrollHeight,
            behavior: 'smooth'
        });

        const scrollEvent = new Event('scroll', { bubbles: true });
        scrollContainer.dispatchEvent(scrollEvent);

        let lastQuestionCount = questionItems.length;
        const checkNewQuestions = setInterval(() => {
            const newQuestionItems = document.querySelectorAll('.question-item');
            if (newQuestionItems.length > lastQuestionCount) {
                console.log("检测到新问题，重新查找未回答问题...");
                clearInterval(checkNewQuestions);
                scrolling = false;
                scrollToLastUnansweredQuestion();
            }
        }, 1000);

        setTimeout(() => {
            clearInterval(checkNewQuestions);
            scrolling = false;
            console.log("未检测到新问题，停止监控。");
            showAlert("未检测到新问题，请稍后重试。");
        }, 10000);
    }

    function initMutationObserver() {
        const debouncedUpdate = debounce(() => {
            console.log("DOM 变化检测到，更新问题列表...");
            addQuestionStatus();
            if (GM_getValue("isAutoScrolling", false) && GM_getValue("workMode", "answer") === "answer") {
                scrollToLastUnansweredQuestion();
            }
            checkHomeRegex();
        }, 500);

        const observer = new MutationObserver(() => {
            debouncedUpdate();
        });

        observer.observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true
        });

        console.log("MutationObserver 已启动，正在监听 DOM 变化...");
    }

    function checkForLatestVersion() {
        const lastChecked = GM_getValue("lastVersionCheck", 0);
        const currentTime = new Date().getTime();
        const oneHourMillis = 60 * 60 * 1000;
        let retryAttempts = 0;
        const maxRetries = 5;
        const retryDelay = 1000;

        function requestVersion() {
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://scriptcat.org/scripts/code/3259/知到智慧树全自动刷问答平时分助手.meta.js",
                onload: function (response) {
                    const match = response.responseText.match(/@version\s+([\d.]+)/);
                    if (match) {
                        const latestVersion = match[1];
                        GM_setValue("lastVersionCheck", currentTime);
                        GM_setValue("lastCheckedVersion", latestVersion);
                        const el = document.getElementById("latestVersion");
                        if (el) el.innerText = latestVersion;
                    } else {
                        if (retryAttempts < maxRetries) {
                            retryAttempts++;
                            setTimeout(requestVersion, retryDelay);
                        } else {
                            const el = document.getElementById("latestVersion");
                            if (el) el.innerText = "获取失败";
                        }
                    }
                }
            });
        }

        if (currentTime - lastChecked > oneHourMillis) {
            requestVersion();
        } else {
            const lastCheckedVersion = GM_getValue("lastCheckedVersion", "未检测");
            const el = document.getElementById("latestVersion");
            if (el) el.innerText = lastCheckedVersion;
        }
    }

    /* ---------- 同步官方“我的回答”：不点题就能知道哪些题已回答过 ----------
       原理：问答列表接口不返回“我是否答过”标记，但“我参与的 → 我的回答”页面
       （路由 #/web/myJoin/<courseId>?...&type=answer）的 Vue 组件里存有
       完整的我答过的题目列表（单页 50 条，noMore=true 即全部）。
       脚本自动跳过去读一遍、标记为已回答，再跳回问答首页继续工作。 */

    let syncingAnswered = false;
    let lastSyncInfo = { total: 0, added: 0, time: 0 }; // 最近一次同步读到的官方列表规模

    // 一致性检查：官方显示数 / 官方实际列表 / 脚本内部记录 三者是否吻合
    function checkCountConsistency() {
        const official = readOfficialCounts().answer;
        const internal = getAnsweredCount();
        const synced = lastSyncInfo.total;
        const msgs = [];
        if (official !== null && synced > 0 && official !== synced) {
            msgs.push(`页面显示“我的回答”${official} 条，但官方记录里实际有 ${synced} 条`);
        }
        if (official !== null && Math.abs(internal - official) > 2) {
            msgs.push(`脚本内部已记录 ${internal} 条，与页面官方 ${official} 条对不上`);
        }
        if (msgs.length) {
            showAlert('数据不一致提醒：' + msgs.join('；') + '。建议点“同步已答”或刷新页面后再看。');
            console.warn('回答数一致性检查:', msgs.join('；'));
        }
    }

    function getCourseIdFromHash() {
        const m = location.hash.match(/#\/web\/(?:home|myJoin|questionDetail)\/(\d+)/);
        return m ? m[1] : null;
    }

    function readMyJoinData() {
        const el = document.querySelector('.my-join-container');
        const v = el && el.__vue__;
        if (!v || !v.$data || !Array.isArray(v.$data.questionList)) return null;
        return {
            list: v.$data.questionList,
            noMore: !!v.$data.noMore,
            loading: !!v.$data.loading
        };
    }

    function applyAnsweredSync(preferCourseName, items) {
        // 页面顶部课程名可能为空，此时用列表数据里自带的 courseName
        const courseName = preferCourseName || (items.find(it => it.courseName) || {}).courseName;
        if (!courseName || !items.length) return { courseName, added: 0 };
        const data = GM_getValue("questionsData", {});
        data[courseName] = data[courseName] || {};
        let added = 0;
        for (const it of items) {
            const q = (it.questionContent || '').trim();
            if (!q) continue;
            if (data[courseName][q] !== '已回答') {
                data[courseName][q] = '已回答';
                added++;
            }
        }
        GM_setValue("questionsData", data);
        return { courseName, added };
    }

    function syncAnsweredFromMyJoin(courseName, done) {
        const courseId = getCourseIdFromHash();
        if (!courseId) { done(); return; }
        syncingAnswered = true;

        const finish = () => {
            syncingAnswered = false;
            // 跳回问答首页
            const u = new URL(location.href);
            const qs = [];
            if (u.searchParams.get('recruitId')) qs.push('recruitId=' + u.searchParams.get('recruitId'));
            if (u.searchParams.get('role')) qs.push('role=' + u.searchParams.get('role'));
            const back = '#/web/home/' + courseId + (qs.length ? '?' + qs.join('&') : '');
            if (!location.hash.startsWith('#/web/home/')) location.hash = back;
            // 等首页题目列表渲染出来后继续工作
            const t0 = Date.now();
            const wait = setInterval(() => {
                if (document.querySelectorAll('.question-item').length > 0 || Date.now() - t0 > 15000) {
                    clearInterval(wait);
                    done();
                }
            }, 500);
        };

        const collect = () => {
            const t0 = Date.now();
            const timer = setInterval(() => {
                const r = readMyJoinData();
                const timeout = Date.now() - t0 > 20000;
                if ((r && r.noMore && !r.loading) || timeout) {
                    clearInterval(timer);
                    const { added } = applyAnsweredSync(courseName, r ? r.list : []);
                    lastSyncInfo = { total: r ? r.list.length : 0, added, time: Date.now() };
                    console.log(`已从官方“我的回答”同步 ${added} 条已回答记录`);
                    showAlert(added > 0
                        ? `同步完成：${added} 道题已标记为已回答（打开立即跳题，不计时）`
                        : "同步完成：没有新的已回答记录");
                    finish();
                }
            }, 500);
        };

        if (location.hash.includes('/web/myJoin/')) {
            collect(); // 已经在我的参与页，直接读
        } else {
            const u = new URL(location.href);
            const recruitId = u.searchParams.get('recruitId');
            const role = u.searchParams.get('role') || '2';
            location.hash = `#/web/myJoin/${courseId}?recruitId=${recruitId}&role=${role}&type=answer`;
            collect();
        }
    }

    /* ==================== 启动 ==================== */

    window.onload = () => {
        console.log("启动智慧树自动回答器 v" + SCRIPT_VERSION + "...");
        injectStyles();

        // ===== 子页面（题目详情页）模式：只回答，不做任何判断 =====
        if (isDetailPage()) {
            console.log("详情页子页面模式：跳过同步/倒计时/跳题，直接进入回答流程");
            ensureChildPanel();
            updateChildQuestion();
            setChildStatus('正在寻找“我来回答”按钮…');
            initMutationObserver();
            if (GM_getValue("workMode", "answer") === "answer") {
                waitForAnswerButton();
            }
            return; // 关键：子页面绝不触发下面的父页面启动逻辑
        }

        // 子页面关闭失败退回的标签：优先再次尝试关闭自己，避免双父页面并行
        if (sessionStorage.getItem('zhsWasChild') === '1') {
            sessionStorage.removeItem('zhsWasChild');
            console.log('检测到关闭失败的子页面退回首页，尝试关闭自己...');
            window.close();
        }

        // 面板立即显示，不等官方数字/同步等后续流程
        ensurePanel();

        // 读取刷新比对标记（每 5 题例行比对 / 脚本计数达标复核），读完即清除
        const countCheckPending = sessionStorage.getItem("zhsCountCheck") === "1";
        const targetVerifyPending = sessionStorage.getItem("zhsTargetVerify") === "1";
        sessionStorage.removeItem("zhsCountCheck");
        sessionStorage.removeItem("zhsTargetVerify");

        if (GM_getValue("workMode", "answer") === "answer") {
            waitForAnswerButton();
        } else {
            console.log("当前为提问模式，跳过回答流程。");
        }

        initMutationObserver();

        const startWork = () => {
            // 打开页面立即工作一轮：先自动跳过已回答/无法回答的题目（跳题不计时），
            // 跳到未答题后由 onWorkTick 自行启动倒计时
            onWorkTick();
        };

        // 进入问答列表：先检查“我参与的”官方回答/提问数是否已达标。
        // 已达标 → 脚本不运行；未达标（或官方数字读不到）→ 同步已答记录 → 开始工作。
        const gate = () => {
            const mode = GM_getValue("workMode", "answer");
            const target = mode === "answer"
                ? GM_getValue("answerTarget", 50)
                : GM_getValue("askTarget", 10);
            const official = readOfficialCounts();
            const value = mode === "answer" ? official.answer : official.asked;

            // 刷新后的比对：脚本计数 vs 官方“我的回答”
            if (mode === "answer" && (countCheckPending || targetVerifyPending)) {
                const scriptCount = getScriptAnsweredCount();
                if (official.answer !== null) {
                    if (official.answer === scriptCount) {
                        showAlert(`比对一致：脚本计数与官方“我的回答”均为 ${scriptCount}`);
                        parentLog(`比对一致：脚本计数 = 官方 = ${scriptCount}`);
                    } else {
                        const diff = scriptCount - official.answer;
                        showAlert(`⚠️ 数量不一致：脚本已答 ${scriptCount}，官方显示 ${official.answer}（差 ${diff > 0 ? "+" : ""}${diff}）`);
                        parentLog(`⚠️ 数量不一致：脚本 ${scriptCount} vs 官方 ${official.answer}（差 ${diff > 0 ? "+" : ""}${diff}），建议人工核对`, 'err');
                    }
                } else {
                    showAlert("刷新后官方数字未加载，无法比对");
                    parentLog("刷新后官方数字未加载，无法比对", 'err');
                }
            }

            // 脚本计数达标复核：官方数字确实达标 → 正常停止；
            // 官方仍偏低（可能延迟/未发布成功）→ 暂停并提醒，等人工确认。
            // verifyDone >= target 表示已复核过一次仍不一致：之后任何刷新/继续都不再自动开跑，避免越答越多。
            if (mode === "answer"
                && getScriptAnsweredCount() >= target
                && (value === null || value < target)
                && (targetVerifyPending || getVerifyDone() >= target)) {
                console.log(`脚本计数已达标（${getScriptAnsweredCount()}/${target}）但官方显示 ${value}，暂停等待人工确认`);
                showAlert(`脚本已答满 ${getScriptAnsweredCount()} 题，但官方仅显示“我的回答”${value}，可能官方延迟或未发布成功。已暂停，请人工确认后再点“继续”。`);
                parentLog(`脚本计数达标但官方仅 ${value}，已暂停待人工确认`, 'err');
                ensurePanelWithRetry();
                updatePanel();
                return;
            }

            if (value !== null && value >= target) {
                console.log(`本课程${mode === "answer" ? "回答" : "提问"}已达标（官方 ${value}/${target}），脚本不运行`);
                showAlert(`本课程${mode === "answer" ? "回答" : "提问"}已达标（官方 ${value}/${target}），脚本不再运行`);
                // 已达标也要把面板显示出来，方便用户切换课程/模式或手动继续
                ensurePanelWithRetry();
                updatePanel();
                return;
            }

            // 未达标：回答模式先同步官方“我的回答”记录，再开始工作
            if (mode === "answer") {
                const t0 = Date.now();
                const waitCourse = setInterval(() => {
                    const courseName = (document.querySelector(".course-name") || {}).innerText?.trim() || "";
                    if (courseName || Date.now() - t0 > 8000) {
                        clearInterval(waitCourse);
                        if (getCourseIdFromHash()) {
                            syncAnsweredFromMyJoin(courseName, () => {
                                checkCountConsistency(); // 同步后检查三方数字是否一致
                                startWork();
                            });
                        } else {
                            startWork();
                        }
                    }
                }, 500);
            } else {
                startWork();
            }
        };

        // 官方数字是异步渲染的：最多等 10 秒；读不到就按未达标处理（进入工作后内部统计兜底）
        const gt0 = Date.now();
        const waitOfficial = setInterval(() => {
            const official = readOfficialCounts();
            const ready = (official.answer !== null) || (official.asked !== null);
            if (ready || Date.now() - gt0 > 10000) {
                clearInterval(waitOfficial);
                gate();
            }
        }, 500);
    };

})();
