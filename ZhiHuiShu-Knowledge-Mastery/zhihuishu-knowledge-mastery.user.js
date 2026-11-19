// ==UserScript==
// @name         智慧树 - 智能课程自动补全知识掌握度
// @namespace    https://github.com/LumiCorn/Browser-Scripts
// @version      0.4.1
// @description  自动补全智慧树课程「知识掌握度」：扫描掌握度页面的遗漏点，逐个进入知识点测试并作答，把遗漏点补成掌握。M3 悬浮面板，防重复、带运行日志。
// @author       LumiCornX
// @match        *://studywisdomh5.zhihuishu.com/*
// @run-at       document-idle
// @downloadURL  https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-Knowledge-Mastery/zhihuishu-knowledge-mastery.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-Knowledge-Mastery/zhihuishu-knowledge-mastery.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     *  0. 脚本身份与配置
     *  改这里就够了：名称、版本、前缀、匹配站点在文件顶部元数据里改。
     *  SCRIPT_VERSION 必须和元数据 @version 保持一致。
     * ================================================================ */

    const SCRIPT_VERSION = '0.4.1';
    const APP_NAME = '智慧树 - 智能课程自动补全知识掌握度';
    const APP_ICON = '🧠';

    // 所有注入 DOM 的 id / class 统一前缀，防止与宿主页面冲突
    const PREFIX = 'zhskm';
    const el = (name) => `${PREFIX}-${name}`;
    const id = (name) => `${PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;

    // 面板可配置项：复制模板后按需增删，设置区会自动渲染
    const DEFAULTS = {
        // 默认不自动开跑：掌握度补全会进答题页，必须由用户主动点「开始」
        enabled: false,
        // 模式：auto = 按顺序做完全部待答；fill = 查漏补缺（<50% 反复做到达标）
        mode: 'auto',
        // 查漏补缺模式的达标阈值（掌握度百分比）
        passThreshold: 50,
        // 同一知识点最多做几轮，超了就当作已完成跳过（防题目太难一直烧 token）
        maxRoundsPerPoint: 5,
        intervalSec: 3,
        apiKey: '',
        apiUrl: 'https://api.gpt.ge/v1/chat/completions',
        model: 'glm-4-flash',
        // 知识点作答完成后，停留多久再返回（毫秒），给页面渲染留时间
        afterSubmitDelay: 1500,
    };

    /* ---------------- 页面结构常量（实测自 studywisdomh5.zhihuishu.com） ----------------
     *  掌握度页 /study/mastery?recruitAndCourseId=...
     *    li.item-box            每个知识点        .gray = 遗漏点(待考)   .blue = 免考
     *    .item-box-name         知识点名（el-tooltip 触发器，需 hover 才出 popover）
     *    .el-popover.mastery-box-custom-popover   悬浮层，内含「提升掌握度」入口
     *  答题页 /exam?name=...&knowledgeId=...&idStr=...&recruitAndCourseId=...
     *    ul.question-item       每道题（5 道全部渲染，只显示当前题）
     *    .el-radio / .el-checkbox  选项（.click() 是切换语义，必须幂等）
     *    .answer-card .item     答题卡          .violet 已作答 / .active 当前题
     *    .header .submit        提交
     *    .el-dialog.custom-exam-dialog  未答完提示 → 「确认提交」「继续作答」
     *    .up-btn / .next-btn    上一题 / 下一题
     *  分数页 /pointOfMastery/...
     *    .backup-icon           返回按钮（左上角圆形箭头 SVG）
     *    .charts-label-rate     掌握度百分比（如 60%）
     *  注：站点会挂腾讯防水墙（turing.captcha.gtimg.com + #captchaYidun），
     *      触发滑块验证时脚本无法伪造 isTrusted，只能停下等人工处理。
     * ------------------------------------------------------------------------------ */
    const SEL = {
        masteryBox: 'li.item-box',
        masteryEmpty: 'gray',       // 遗漏点：掌握度 0%
        masteryPass: 'blue',        // 免考：不参与作答
        masteryPink: 'pink',        // 薄弱点：掌握度 1-59
        masteryOrigin: 'origin',    // 掌握一般：掌握度 60-79
        masteryGood: 'green',       // 掌握较好：掌握度 >= 80
        masteryName: '.item-box-name',
        popover: '.el-popover.mastery-box-custom-popover',
        upgradeBtnText: '提升掌握度',
        examItem: 'ul.question-item',
        questType: '.quest-type',
        questTitle: '.option-name',
        optionRadio: '.el-radio',
        optionCheckbox: '.el-checkbox',
        optionLetter: '.ccc',
        optionText: '.preStyle',
        answerCardItem: '.answer-card .item',
        submitBtn: '.header .submit',
        confirmDialog: '.el-dialog.custom-exam-dialog',
        confirmSubmitText: '确认提交',
        continueText: '继续作答',
        nextBtn: '.next-btn',
        backBtn: '.backup-icon',
        scoreRate: '.charts-label-rate',
        captchaFrame: 'iframe[src*="captcha.gtimg.com"]',
        captchaNode: '#captchaYidun',
    };

    /* ---------------- 路径判断 ---------------- */
    const isMasteryPage = () => /\/study\/mastery/.test(location.pathname + location.search);
    const isExamPage = () => /^\/exam\b/.test(location.pathname);
    const isResultPage = () => /\/pointOfMastery\//.test(location.pathname);

    /* ================================================================
     *  1. GM API 兼容层
     *  Tampermonkey / ScriptCat / Violentmonkey 的 API 命名不一致，
     *  这里统一成小写形式，缺失的提供内存降级，保证模板在任何
     *  管理器下都能跑起来（不会因为少一个 API 直接崩掉）。
     * ================================================================ */

    const GM = (() => {
        const g = typeof globalThis !== 'undefined' ? globalThis : window;
        const memory = new Map();

        const setValue = (key, value) => {
            try {
                if (typeof g.GM_setValue === 'function') return g.GM_setValue(key, value);
                if (typeof g.GM?.setValue === 'function') return g.GM.setValue(key, value);
            } catch (e) { /* 降级到内存 */ }
            memory.set(key, value);
        };

        const getValue = (key, fallback) => {
            try {
                if (typeof g.GM_getValue === 'function') {
                    const v = g.GM_getValue(key, fallback);
                    return v === undefined ? fallback : v;
                }
                if (typeof g.GM?.getValue === 'function') {
                    const v = g.GM.getValue(key, fallback);
                    return v === undefined ? fallback : v;
                }
            } catch (e) { /* 降级到内存 */ }
            return memory.has(key) ? memory.get(key) : fallback;
        };

        const deleteValue = (key) => {
            try {
                if (typeof g.GM_deleteValue === 'function') return g.GM_deleteValue(key);
                if (typeof g.GM?.deleteValue === 'function') return g.GM.deleteValue(key);
            } catch (e) { /* ignore */ }
            memory.delete(key);
        };

        const registerMenuCommand = (label, fn) => {
            try {
                if (typeof g.GM_registerMenuCommand === 'function') return g.GM_registerMenuCommand(label, fn);
                if (typeof g.GM?.registerMenuCommand === 'function') return g.GM.registerMenuCommand(label, fn);
            } catch (e) { /* 无菜单支持时静默 */ }
        };

        const notification = (text, title = APP_NAME) => {
            try {
                if (typeof g.GM_notification === 'function') return g.GM_notification(text, title);
                if (typeof g.GM?.notification === 'function') return g.GM.notification(text, title);
            } catch (e) { /* ignore */ }
        };

        const openInTab = (url, options = { active: false, insert: true }) => {
            try {
                if (typeof g.GM_openInTab === 'function') return g.GM_openInTab(url, options);
                if (typeof g.GM?.openInTab === 'function') return g.GM.openInTab(url, options);
            } catch (e) { /* ignore */ }
            return window.open(url, '_blank');
        };

        const addValueChangeListener = (key, fn) => {
            try {
                if (typeof g.GM_addValueChangeListener === 'function') return g.GM_addValueChangeListener(key, fn);
                if (typeof g.GM?.addValueChangeListener === 'function') return g.GM.addValueChangeListener(key, fn);
            } catch (e) { /* ignore */ }
            return null;
        };

        // 优先用 GM_xmlhttpRequest 绕开页面 CSP，失败再退回 fetch
        const request = (opts = {}) => new Promise((resolve, reject) => {
            const { url, method = 'GET', headers = {}, data = null, timeout = 30000 } = opts;
            const hasGM = typeof g.GM_xmlhttpRequest === 'function' || typeof g.GM?.xmlHttpRequest === 'function';
            if (hasGM) {
                const fn = typeof g.GM_xmlhttpRequest === 'function' ? g.GM_xmlhttpRequest : g.GM.xmlHttpRequest;
                fn({
                    method, url, headers, data, timeout,
                    onload: (res) => resolve({ status: res.status, text: res.responseText, json: () => JSON.parse(res.responseText) }),
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error('GM_xmlhttpRequest 超时')),
                });
                return;
            }
            // 降级：用页面 fetch，可能被 CSP 拦
            fetch(url, { method, headers, body: data })
                .then((res) => res.text().then((text) => resolve({ status: res.status, text, json: () => JSON.parse(text) })))
                .catch(reject);
        });

        // 页面侧的 window（某些管理器里直接访问需 unsafeWindow）
        const pageWindow = (() => {
            try {
                if (typeof g.unsafeWindow !== 'undefined' && g.unsafeWindow) return g.unsafeWindow;
            } catch (e) { /* ignore */ }
            return window;
        })();

        return {
            setValue, getValue, deleteValue, registerMenuCommand,
            notification, openInTab, addValueChangeListener, request, pageWindow,
        };
    })();

    /* ================================================================
     *  2. 设置读写
     * ================================================================ */

    function loadSettings() {
        const saved = GM.getValue('settings', {}) || {};
        return Object.assign({}, DEFAULTS, typeof saved === 'object' ? saved : {});
    }

    function saveSettings(next) {
        GM.setValue('settings', Object.assign({}, DEFAULTS, next));
    }

    let settings = loadSettings();

    /* ================================================================
     *  3. 运行日志（持久留存，可回看）
     * ================================================================ */

    const LOG_LIMIT = 50;
    const logEntries = [];

    function stamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function log(text, level = 'info') {
        const entry = { t: stamp(), text: String(text), level };
        logEntries.push(entry);
        if (logEntries.length > LOG_LIMIT) logEntries.shift();
        if (level === 'error') console.error(`[${APP_NAME}]`, text);
        else console.log(`[${APP_NAME}]`, text);
        renderLog();
    }

    function renderLog() {
        const box = document.getElementById(id('logList'));
        if (!box) return;
        box.innerHTML = logEntries
            .map((e) => `<div class="${el('log-item')} ${el(`log-${e.level}`)}" data-t="${e.t}">${escapeHtml(e.text)}</div>`)
            .join('');
        box.scrollTop = box.scrollHeight;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    /* ================================================================
     *  4. Toast（M3 Snackbar 风格）
     * ================================================================ */

    function toast(message, level = 'info') {
        log(message, level);
        if (document.hidden) return;

        let stack = document.getElementById(id('toastStack'));
        if (!stack) {
            stack = document.createElement('div');
            stack.id = id('toastStack');
            stack.className = el('toast-stack');
            document.body.appendChild(stack);
        }

        const node = document.createElement('div');
        node.className = `${el('toast')} ${el(`toast-${level}`)}`;
        node.textContent = message;
        stack.appendChild(node);

        requestAnimationFrame(() => node.classList.add('show'));
        setTimeout(() => {
            node.classList.remove('show');
            setTimeout(() => node.remove(), 300);
        }, 2500);
    }

    /* ================================================================
     *  5. 样式注入（Material Design 3，参考 Material-Design-Constitution）
     *  令牌全部跨主题一致，只做亮色；需要暗色时给 body 加 data-theme。
     * ================================================================ */

    function injectStyles() {
        if (document.getElementById(id('style'))) return;
        const style = document.createElement('style');
        style.id = id('style');
        style.textContent = `
            .${el('panel')}, .${el('log-panel')}, .${el('toast-stack')}, .${el('toast')} {
                --md-sys-color-primary: #2563eb;
                --md-sys-color-on-primary: #ffffff;
                --md-sys-color-primary-container: #dbe7fe;
                --md-sys-color-on-primary-container: #0b2a6b;
                --md-sys-color-surface: #ffffff;
                --md-sys-color-on-surface: #1a1c1e;
                --md-sys-color-surface-variant: #f3f4f6;
                --md-sys-color-on-surface-variant: #4b5563;
                --md-sys-color-surface-container-low: #f8f9fb;
                --md-sys-color-outline: #9ca3af;
                --md-sys-color-outline-variant: #e5e7eb;
                --md-sys-color-error: #dc2626;
                --md-sys-color-success: #16a34a;
                --md-sys-color-warning: #d97706;
                --md-state-hover: 0.08;
                --md-sys-shape-corner-small: 8px;
                --md-sys-shape-corner-medium: 12px;
                --md-sys-shape-corner-large: 16px;
                --md-sys-shape-corner-full: 9999px;
                --md-sys-elevation-1: 0 1px 2px rgba(17,24,39,.30), 0 1px 3px 1px rgba(17,24,39,.15);
                --md-sys-elevation-2: 0 2px 6px 2px rgba(17,24,39,.15), 0 1px 2px rgba(17,24,39,.30);
                --md-sys-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }

            /* ---------- 悬浮主面板（M3 Elevated Card） ---------- */
            .${el('panel')} {
                position: fixed; top: 90px; right: 24px; width: 320px;
                background: var(--md-sys-color-surface);
                border-radius: var(--md-sys-shape-corner-large);
                box-shadow: var(--md-sys-elevation-2);
                color: var(--md-sys-color-on-surface);
                font-family: var(--md-sys-font); font-size: 13px;
                z-index: 2147483000; overflow: hidden; user-select: none;
            }
            .${el('header')} {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 16px; cursor: move;
                border-bottom: 1px solid var(--md-sys-color-outline-variant);
            }
            .${el('title')} {
                font-weight: 500; font-size: 15px; flex: 1; letter-spacing: .15px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .${el('ver')} {
                font-size: 10px; font-weight: normal;
                color: var(--md-sys-color-on-surface-variant);
                background: var(--md-sys-color-surface-variant);
                padding: 2px 7px; border-radius: var(--md-sys-shape-corner-full);
                margin-left: 4px;
            }
            .${el('icon-btn')} {
                background: transparent; border: none;
                color: var(--md-sys-color-on-surface-variant);
                width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
                font-size: 13px; line-height: 1; display: flex;
                align-items: center; justify-content: center;
                font-family: inherit; transition: background .15s;
            }
            .${el('icon-btn')}:hover {
                background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent);
            }
            .${el('body')} { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
            .${el('panel')}.collapsed .${el('body')} { display: none; }

            /* M3 Segmented Button：模式切换 */
            .${el('segmented')} {
                display: flex; background: var(--md-sys-color-surface-variant);
                border-radius: var(--md-sys-shape-corner-full); padding: 3px; gap: 2px;
                border: 1px solid var(--md-sys-color-outline-variant);
            }
            .${el('segment')} {
                flex: 1; border: none; background: transparent;
                color: var(--md-sys-color-on-surface-variant);
                padding: 8px 0; border-radius: var(--md-sys-shape-corner-full);
                cursor: pointer; font-size: 13px; font-family: inherit;
                font-weight: 500; letter-spacing: .1px; transition: all .18s;
            }
            .${el('segment')}:hover { color: var(--md-sys-color-on-surface); }
            .${el('segment')}.active {
                background: var(--md-sys-color-surface);
                color: var(--md-sys-color-primary);
                font-weight: 600; box-shadow: var(--md-sys-elevation-1);
            }

            /* 模式说明 */
            .${el('mode-hint')} {
                font-size: 11px; line-height: 1.5;
                color: var(--md-sys-color-on-surface-variant);
                background: var(--md-sys-color-surface-container-low);
                border-radius: var(--md-sys-shape-corner-small);
                padding: 6px 8px;
            }

            /* 状态行 */
            .${el('status-row')} {
                display: flex; align-items: center; gap: 7px;
                color: var(--md-sys-color-on-surface-variant); font-size: 12px;
            }
            .${el('dot')} {
                width: 8px; height: 8px; border-radius: 50%;
                background: var(--md-sys-color-success); flex-shrink: 0;
            }
            .${el('dot')}.idle { background: var(--md-sys-color-warning); }
            .${el('dot')}.error { background: var(--md-sys-color-error); }

            /* 进度条 */
            .${el('progress-info')} {
                display: flex; justify-content: space-between;
                font-size: 12px; color: var(--md-sys-color-on-surface-variant);
                margin-bottom: 5px;
            }
            .${el('progress-track')} {
                height: 6px; border-radius: var(--md-sys-shape-corner-full);
                background: var(--md-sys-color-surface-variant); overflow: hidden;
            }
            .${el('progress-fill')} {
                height: 100%; width: 0%;
                background: var(--md-sys-color-primary);
                border-radius: var(--md-sys-shape-corner-full);
                transition: width .4s ease;
            }

            /* 统计行：需作答 / 已完成 / 剩余 / 免考 */
            .${el('stats')} { display: flex; gap: 6px; }
            .${el('stat')} {
                flex: 1; text-align: center; padding: 6px 2px;
                background: var(--md-sys-color-surface-container-low);
                border: 1px solid var(--md-sys-color-outline-variant);
                border-radius: var(--md-sys-shape-corner-small);
                font-size: 10.5px; color: var(--md-sys-color-on-surface-variant);
                display: flex; flex-direction: column; gap: 1px;
                font-variant-numeric: tabular-nums;
            }
            .${el('stat')} b {
                font-size: 14px; font-weight: 600;
                color: var(--md-sys-color-on-surface);
            }

            /* M3 Buttons：Filled / Outlined Pill */
            .${el('actions')} { display: flex; gap: 8px; flex-wrap: wrap; }
            .${el('btn')} {
                border: none; border-radius: var(--md-sys-shape-corner-full);
                padding: 8px 16px; font-size: 12.5px; cursor: pointer;
                font-weight: 500; font-family: inherit; letter-spacing: .1px;
                transition: all .15s;
                color: var(--md-sys-color-on-surface-variant);
                background: transparent;
            }
            .${el('btn')}.primary {
                background: var(--md-sys-color-primary);
                color: var(--md-sys-color-on-primary);
            }
            .${el('btn')}.primary:hover {
                background: color-mix(in srgb, var(--md-sys-color-on-primary) var(--md-state-hover), var(--md-sys-color-primary));
                box-shadow: var(--md-sys-elevation-1);
            }
            .${el('btn')}.ghost { border: 1px solid var(--md-sys-color-outline-variant); }
            .${el('btn')}.ghost:hover {
                background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-state-hover), transparent);
            }

            /* 设置区 */
            .${el('settings')} summary {
                cursor: pointer; color: var(--md-sys-color-on-surface-variant);
                font-size: 12px; padding: 4px 0; list-style: none;
            }
            .${el('settings')} summary::before { content: '▸ '; }
            .${el('settings')}[open] summary::before { content: '▾ '; }
            .${el('settings')}[open] summary { margin-bottom: 10px; }
            .${el('settings-fields')} { display: flex; flex-direction: column; gap: 9px; }
            .${el('field')} { display: flex; flex-direction: column; gap: 4px; flex: 1; }
            .${el('field')} label { font-size: 11px; color: var(--md-sys-color-on-surface-variant); }
            /* M3 Outlined Text Field */
            .${el('field')} input {
                background: var(--md-sys-color-surface);
                border: 1px solid var(--md-sys-color-outline);
                border-radius: var(--md-sys-shape-corner-small);
                padding: 8px 10px; color: var(--md-sys-color-on-surface);
                font-size: 12.5px; outline: none; width: 100%;
                box-sizing: border-box; font-family: inherit;
                transition: border-color .15s;
            }
            .${el('field')} input:hover { border-color: var(--md-sys-color-on-surface-variant); }
            .${el('field')} input:focus {
                border-color: var(--md-sys-color-primary);
                border-width: 2px; padding: 7px 9px;
            }
            .${el('field-row')} { display: flex; gap: 8px; }

            /* ---------- 运行日志窗（左下角） ---------- */
            .${el('log-panel')} {
                position: fixed; left: 16px; bottom: 16px; width: 320px;
                background: var(--md-sys-color-surface);
                border-radius: var(--md-sys-shape-corner-large);
                box-shadow: var(--md-sys-elevation-2);
                color: var(--md-sys-color-on-surface);
                font-family: var(--md-sys-font); font-size: 12.5px;
                z-index: 2147482999; overflow: hidden;
            }
            .${el('log-header')} {
                display: flex; align-items: center; gap: 6px;
                padding: 10px 14px; font-weight: 500; font-size: 13px;
                border-bottom: 1px solid var(--md-sys-color-outline-variant);
                cursor: pointer;
            }
            .${el('log-header')} .spacer { flex: 1; }
            .${el('log-list')} {
                max-height: 160px; overflow-y: auto; padding: 8px 14px 10px;
                display: flex; flex-direction: column; gap: 3px;
            }
            .${el('log-panel')}.collapsed .${el('log-list')} { display: none; }
            .${el('log-item')} {
                color: var(--md-sys-color-on-surface-variant);
                font-size: 11.5px; line-height: 1.5; word-break: break-all;
            }
            .${el('log-item')}::before {
                content: attr(data-t) '  ';
                color: var(--md-sys-color-outline); font-size: 10.5px;
                font-variant-numeric: tabular-nums;
            }
            .${el('log-success')} { color: var(--md-sys-color-success); }
            .${el('log-error')} { color: var(--md-sys-color-error); }
            .${el('log-warn')} { color: var(--md-sys-color-warning); }

            /* ---------- Toast（Snackbar） ---------- */
            .${el('toast-stack')} {
                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                z-index: 2147483647; display: flex; flex-direction: column-reverse;
                gap: 8px; pointer-events: none;
            }
            .${el('toast')} {
                background: var(--md-sys-color-surface-container-low);
                border-left: 3px solid var(--md-sys-color-primary);
                color: var(--md-sys-color-on-surface);
                padding: 12px 18px; border-radius: var(--md-sys-shape-corner-medium);
                font-size: 13px; font-family: var(--md-sys-font);
                box-shadow: var(--md-sys-elevation-2);
                max-width: 70vw; opacity: 0; transform: translateY(8px);
                transition: opacity .25s, transform .25s;
            }
            .${el('toast')}.show { opacity: 1; transform: translateY(0); }
            .${el('toast-error')} { border-left-color: var(--md-sys-color-error); }
            .${el('toast-success')} { border-left-color: var(--md-sys-color-success); }
            .${el('toast-warn')} { border-left-color: var(--md-sys-color-warning); }
        `;
        document.head.appendChild(style);
    }

    /* ================================================================
     *  6. 主面板：创建 / 拖拽 / 折叠 / 位置记忆 / 设置
     * ================================================================ */

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = id('panel');
        panel.className = el('panel') + (GM.getValue('panelCollapsed', false) ? ' collapsed' : '');
        panel.innerHTML = `
            <div class="${el('header')}">
                <span>${APP_ICON}</span>
                <span class="${el('title')}">${escapeHtml(APP_NAME)}<span class="${el('ver')}">v${SCRIPT_VERSION}</span></span>
                <button class="${el('icon-btn')}" id="${id('collapseBtn')}" title="折叠/展开">—</button>
            </div>
            <div class="${el('body')}">
                <div class="${el('segmented')}">
                    <button class="${el('segment')} active" data-mode="auto">自动</button>
                    <button class="${el('segment')}" data-mode="fill">查漏补缺</button>
                </div>
                <div class="${el('mode-hint')}" id="${id('modeHint')}"></div>
                <div class="${el('status-row')}">
                    <span class="${el('dot')}" id="${id('dot')}"></span>
                    <span id="${id('statusText')}">就绪</span>
                </div>
                <div>
                    <div class="${el('progress-info')}">
                        <span id="${id('progressText')}">进度 0 / 0</span>
                        <span id="${id('progressSub')}"></span>
                    </div>
                    <div class="${el('progress-track')}">
                        <div class="${el('progress-fill')}" id="${id('progressFill')}"></div>
                    </div>
                </div>
                <div class="${el('stats')}" id="${id('stats')}"></div>
                <div class="${el('actions')}">
                    <button class="${el('btn')} primary" id="${id('mainBtn')}">开始</button>
                    <button class="${el('btn')} ghost" id="${id('logBtn')}">日志</button>
                </div>
                <details class="${el('settings')}">
                    <summary>设置</summary>
                    <div class="${el('settings-fields')}">
                        <div class="${el('field')}">
                            <label>API Key（答题用，留空则仅扫描）</label>
                            <input type="password" id="${id('apiKeyInput')}" autocomplete="off">
                        </div>
                        <div class="${el('field')}">
                            <label>API URL</label>
                            <input type="text" id="${id('apiUrlInput')}">
                        </div>
                        <div class="${el('field-row')}">
                            <div class="${el('field')}">
                                <label>模型</label>
                                <input type="text" id="${id('modelInput')}">
                            </div>
                            <div class="${el('field')}">
                                <label>扫描间隔(秒)</label>
                                <input type="number" id="${id('intervalInput')}" min="1" max="600">
                            </div>
                        </div>
                        <div class="${el('field-row')}">
                            <div class="${el('field')}">
                                <label>达标阈值(%)</label>
                                <input type="number" id="${id('passThresholdInput')}" min="1" max="100">
                            </div>
                            <div class="${el('field')}">
                                <label>单点最多轮次</label>
                                <input type="number" id="${id('maxRoundsInput')}" min="1" max="20">
                            </div>
                        </div>
                        <div class="${el('field')}">
                            <label>交卷后停留(ms)</label>
                            <input type="number" id="${id('afterSubmitDelayInput')}" min="200" max="10000">
                        </div>
                        <div class="${el('actions')}">
                            <button class="${el('btn')} primary" id="${id('saveBtn')}">保存设置</button>
                            <button class="${el('btn')} ghost" id="${id('resetBtn')}">恢复默认</button>
                        </div>
                    </div>
                </details>
            </div>
        `;
        return panel;
    }

    function ensurePanel() {
        if (!document.body) return;
        let panel = document.getElementById(id('panel'));
        if (!panel) {
            injectStyles();
            panel = createPanel();
            document.body.appendChild(panel);
            setupPanelEvents(panel);
            syncPanelFromSettings();
        }
        renderStatus();
    }

    function syncPanelFromSettings() {
        const set = (k, v) => { const n = document.getElementById(id(k)); if (n) n.value = v; };
        set('apiKeyInput', settings.apiKey);
        set('apiUrlInput', settings.apiUrl);
        set('modelInput', settings.model);
        set('intervalInput', settings.intervalSec);
        set('passThresholdInput', settings.passThreshold);
        set('maxRoundsInput', settings.maxRoundsPerPoint);
        set('afterSubmitDelayInput', settings.afterSubmitDelay);
        // 模式按钮高亮
        document.querySelectorAll(`.${el('segment')}`).forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === (settings.mode === 'fill' ? 'fill' : 'auto'));
        });
        renderModeHint();
    }

    /** 模式说明小字 */
    function renderModeHint() {
        const box = document.getElementById(id('modeHint'));
        if (!box) return;
        box.textContent = settings.mode === 'fill'
            ? `查漏补缺：把掌握度 < ${settings.passThreshold}% 的知识点反复做到达标`
            : '自动：按顺序把还没做过的知识点全部做完一遍';
    }

    function renderStatus(state = null) {
        const dot = document.getElementById(id('dot'));
        const text = document.getElementById(id('statusText'));
        const mainBtn = document.getElementById(id('mainBtn'));
        if (!dot || !text || !mainBtn) return;
        const s = state || (settings.enabled ? { kind: 'on', label: '运行中' } : { kind: 'off', label: '已停止' });
        dot.className = el('dot') + (s.kind === 'off' ? ' idle' : s.kind === 'error' ? ' error' : '');
        text.textContent = s.label;
        mainBtn.textContent = settings.enabled ? '停止' : '开始';
    }

    function setProgress(done, total, sub = '') {
        const txt = document.getElementById(id('progressText'));
        const fill = document.getElementById(id('progressFill'));
        const subEl = document.getElementById(id('progressSub'));
        if (txt) txt.textContent = `进度 ${done} / ${total}`;
        if (fill) fill.style.width = (total > 0 ? Math.min(100, done / total * 100) : 0) + '%';
        if (subEl) subEl.textContent = sub;
    }

    /**
     * 跨页面状态：从掌握度页跳到答题页会整页重载，
     * 当前知识点和运行开关必须落盘，否则答题页不知道在答哪一题。
     */
    const RUNTIME_KEY = 'runtime';

    function saveRuntime(patch) {
        const cur = GM.getValue(RUNTIME_KEY, {}) || {};
        GM.setValue(RUNTIME_KEY, Object.assign({}, cur, patch));
    }

    function loadRuntime() {
        return GM.getValue(RUNTIME_KEY, {}) || {};
    }

    /* ---------------- 作答轮次账本 ----------------
     * 记录"每个知识点已经被做了几轮"，跨页面/跨轮次持久化。
     *
     * 为什么必须单独存：currentPoint.rounds 只活在当前这次流程里，
     * 一旦流程重启或中途离开就归零，轮次上限也就失效了，会无限重做烧 token。
     * 键 = 知识点名（而不是 index，因为列表顺序可能变）。
     */
    const ROUND_KEY = 'roundLedger';

    function loadLedger() {
        const v = GM.getValue(ROUND_KEY, {});
        return (v && typeof v === 'object') ? v : {};
    }

    function ledgerGet(name) {
        const l = loadLedger();
        return typeof l[name] === 'number' ? l[name] : 0;
    }

    function ledgerBump(name) {
        if (!name) return 0;
        const l = loadLedger();
        l[name] = (typeof l[name] === 'number' ? l[name] : 0) + 1;
        GM.setValue(ROUND_KEY, l);
        return l[name];
    }

    function ledgerReset() {
        GM.setValue(ROUND_KEY, {});
    }

    /**
     * 该知识点是否已达轮次上限、应当放弃。
     * 这是"题目太难一直做错"的最终保险：做满 N 轮就当作完成，不再碰它。
     */
    function isGaveUp(p) {
        return ledgerGet(p.name) >= settings.maxRoundsPerPoint;
    }

    function setupPanelEvents(panel) {
        // 折叠
        const collapseBtn = panel.querySelector(`#${id('collapseBtn')}`);
        collapseBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            GM.setValue('panelCollapsed', collapsed);
            collapseBtn.textContent = collapsed ? '▢' : '—';
        });
        if (GM.getValue('panelCollapsed', false)) collapseBtn.textContent = '▢';

        // 拖拽（限制在视口内）
        const header = panel.querySelector(`.${el('header')}`);
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
            const nl = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, sl + e.clientX - sx));
            const nt = Math.max(0, Math.min(window.innerHeight - 44, st + e.clientY - sy));
            panel.style.left = `${nl}px`;
            panel.style.top = `${nt}px`;
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            GM.setValue('panelPos', { left: panel.style.left, top: panel.style.top });
        });

        // 恢复位置；历史位置若已飞出视口则重置
        const savedPos = GM.getValue('panelPos', null);
        if (savedPos && savedPos.left && savedPos.top) {
            panel.style.right = 'auto';
            panel.style.left = savedPos.left;
            panel.style.top = savedPos.top;
            requestAnimationFrame(() => {
                const r = panel.getBoundingClientRect();
                if (r.left > window.innerWidth - 60 || r.right < 60 ||
                    r.top > window.innerHeight - 40 || r.bottom < 40) {
                    panel.style.left = 'auto';
                    panel.style.right = '24px';
                    panel.style.top = '90px';
                    GM.setValue('panelPos', null);
                    log('面板历史位置超出视口，已重置');
                }
            });
        }

        // Segmented Button：模式切换（自动 / 查漏补缺）
        panel.querySelectorAll(`.${el('segment')}`).forEach((btn) => {
            btn.addEventListener('click', () => {
                if (settings.enabled) { toast('请先停止再切换模式', 'warn'); return; }
                settings.mode = btn.dataset.mode === 'fill' ? 'fill' : 'auto';
                saveSettings(settings);
                syncPanelFromSettings();
                // 用户要求：每次切模式都重新加载进度条（两种模式的分子算法不同）
                refreshMasteryStats();
                const mode = settings.mode === 'fill' ? 'fill' : 'auto';
                const stats = computeProgress(points, mode, settings.passThreshold);
                log(`已切换到${mode === 'fill' ? '查漏补缺' : '自动'}模式：需考察 ${stats.total}，已完成 ${stats.done}，剩余 ${stats.total - stats.done}`);
                toast(settings.mode === 'fill' ? '已切换到查漏补缺模式' : '已切换到自动模式');
            });
        });

        // 主按钮：开始/停止
        panel.querySelector(`#${id('mainBtn')}`).addEventListener('click', () => {
            settings.enabled = !settings.enabled;
            saveSettings(settings);
            syncPanelFromSettings();
            renderStatus();
            onToggle(settings.enabled); // ← 业务钩子（内部会做页面闸门校验）
        });

        // 日志窗开关
        panel.querySelector(`#${id('logBtn')}`).addEventListener('click', () => ensureLogPanel());

        // 保存设置
        panel.querySelector(`#${id('saveBtn')}`).addEventListener('click', () => {
            const num = (v, d) => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : d;
            };
            settings = {
                ...settings,
                apiKey: document.getElementById(id('apiKeyInput')).value.trim(),
                apiUrl: document.getElementById(id('apiUrlInput')).value.trim() || DEFAULTS.apiUrl,
                model: document.getElementById(id('modelInput')).value.trim() || DEFAULTS.model,
                intervalSec: num(document.getElementById(id('intervalInput')).value, DEFAULTS.intervalSec),
                passThreshold: Math.min(100, num(document.getElementById(id('passThresholdInput')).value, DEFAULTS.passThreshold)),
                maxRoundsPerPoint: num(document.getElementById(id('maxRoundsInput')).value, DEFAULTS.maxRoundsPerPoint),
                afterSubmitDelay: num(document.getElementById(id('afterSubmitDelayInput')).value, DEFAULTS.afterSubmitDelay),
            };
            saveSettings(settings);
            syncPanelFromSettings();
            toast('设置已保存', 'success');
        });

        // 恢复默认
        panel.querySelector(`#${id('resetBtn')}`).addEventListener('click', () => {
            settings = { ...DEFAULTS };
            saveSettings(settings);
            syncPanelFromSettings();
            renderStatus();
            toast('已恢复默认设置');
        });
    }

    /* ================================================================
     *  7. 运行日志窗（左下角，可折叠）
     * ================================================================ */

    function ensureLogPanel() {
        if (!document.body) return;
        injectStyles();
        let panel = document.getElementById(id('logPanel'));
        if (!panel) {
            panel = document.createElement('div');
            panel.id = id('logPanel');
            panel.className = el('log-panel');
            panel.innerHTML = `
                <div class="${el('log-header')}" id="${id('logHeader')}">
                    <span>📋 运行日志</span><span class="spacer"></span>
                    <button class="${el('icon-btn')}" id="${id('logClearBtn')}" title="清空">🗑</button>
                </div>
                <div class="${el('log-list')}" id="${id('logList')}"></div>
            `;
            document.body.appendChild(panel);
            panel.querySelector(`#${id('logHeader')}`).addEventListener('click', (e) => {
                if (e.target.closest('#logClearBtn')) return;
                panel.classList.toggle('collapsed');
            });
            panel.querySelector(`#${id('logClearBtn')}`).addEventListener('click', () => {
                logEntries.length = 0;
                renderLog();
            });
        } else {
            panel.classList.remove('collapsed');
        }
        renderLog();
    }

    /* ================================================================
     *  8. 业务钩子 —— 知识掌握度补全
     *
     *  当前进度：骨架版（v0.1.0）。已接上「扫描」这一半，
     *  能数清有多少遗漏点、它们叫什么；「逐个补全」那半留待确定
     *  答题来源（AI 作答 / 人工核对）后接入。
     *
     *  实测确认的补全链路：
     *    掌握度页 li.item-box.gray（遗漏点）
     *      → 悬停出 .el-popover.mastery-box-custom-popover
     *      → 点「提升掌握度」→ 跳 /exam?knowledgeId=...&idStr=...
     *      → 答题页 5 道题 → 点 .header .submit 提交
     * ================================================================ */

    // 防重入锁：同一时刻只允许一个知识点流程在跑
    let busy = false;
    // 扫描结果
    let points = [];
    // 当前处理中的知识点（跨页面时保留在 GM 存储里，供答题页接续）
    let currentPoint = null;
    // 本知识点的重试计数
    let retryCount = 0;
    // 定时检查器：带次数上限，到点自动停
    let workTimer = null;
    let tickCount = 0;
    const SCAN_TICK_LIMIT = 200;

    // 主按钮切换时调用
    function onToggle(enabled) {
        if (enabled) startWork(); else stopWork();
    }

    function startWork() {
        stopWork();

        // 严格页面判定：只在"页面确实是掌握度页"时才允许启动
        const gate = checkPageGate();
        if (!gate.ok) {
            settings.enabled = false;
            saveSettings(settings);
            syncPanelFromSettings();
            renderStatus({ kind: 'error', label: '页面不匹配' });
            log(`无法启动：${gate.reason}`, 'error');
            toast(gate.reason, 'error');
            return;
        }

        tickCount = 0;
        saveRuntime({ running: true });
        log(`知识掌握度补全：开始（${settings.mode === 'fill' ? '查漏补缺' : '自动'}模式，${gate.reason}）`);
        renderStatus({ kind: 'on', label: '运行中' });
        workTimer = setInterval(() => {
            if (!settings.enabled) { stopWork(); return; }
            tick();
        }, Math.max(1, settings.intervalSec) * 1000);
        tick();
    }

    /**
     * 页面闸门：只有满足全部条件才允许启动。
     * 这是用户要求的"只有在满足我给的这个页面时，才可以启动脚本"。
     */
    function checkPageGate() {
        // 1) 域名必须是被 @match 覆盖的
        if (location.hostname !== 'studywisdomh5.zhihuishu.com') {
            return { ok: false, reason: `当前域名不是智慧树课程页：${location.hostname}` };
        }
        // 2) 路径必须是掌握度页
        if (!isMasteryPage()) {
            return { ok: false, reason: `当前不是知识掌握度页：${location.pathname}` };
        }
        // 3) URL 必须带课程参数
        const params = new URLSearchParams(location.search);
        if (!params.get('recruitAndCourseId')) {
            return { ok: false, reason: '缺少课程参数 recruitAndCourseId' };
        }
        // 4) 知识点必须已经渲染出来
        if (!document.querySelectorAll(SEL.masteryBox).length) {
            return { ok: false, reason: '知识点还没加载出来，请稍后再试' };
        }
        // 5) 必须填写 API Key
        if (!settings.apiKey) {
            return { ok: false, reason: '请先在设置里填写 API Key' };
        }
        return { ok: true, reason: '掌握度页校验通过' };
    }

    function stopWork() {
        if (workTimer) {
            clearInterval(workTimer);
            workTimer = null;
            log('知识掌握度补全：已停止');
        }
        busy = false;
        saveRuntime({ running: false, currentPoint: null });
        renderStatus({ kind: 'off', label: '已停止' });
    }

    /* ---------------- 主循环：按当前所在页面分派 ---------------- */

    function tick() {
        tickCount += 1;
        if (tickCount > SCAN_TICK_LIMIT) {
            log(`已轮询 ${SCAN_TICK_LIMIT} 次仍未完成，自动停止`, 'warn');
            stopWork();
            return;
        }
        if (captchaBlocking()) {
            log('检测到验证码拦截，已暂停，请手动完成验证后继续', 'error');
            renderStatus({ kind: 'error', label: '等待验证码' });
            return;
        }
        if (busy) return;   // 上一轮的异步流程还没结束

        if (isMasteryPage()) { runOnMasteryPage(); return; }
        if (isExamPage()) { runOnExamPage(); return; }
        if (isResultPage()) { runOnResultPage(); return; }
        log('当前页面不在掌握度 / 答题 / 分数页范围内，等待', 'warn');
    }

    /* ---------------- 1. 掌握度页：统计 + 进度条 + 挑下一个知识点 ---------------- */

    function runOnMasteryPage() {
        const boxes = document.querySelectorAll(SEL.masteryBox);
        if (!boxes.length) {
            log('知识点节点还没渲染出来，等待中', 'warn');
            return;
        }

        // 刚从答题页返回时，热力图数据可能还在刷新。
        // 结算前先等 popover 的比例稳定，避免拿旧百分比去判断是否达标。
        if (currentPoint && currentPoint.rounds) {
            busy = true;
            waitForFreshHeatmap().then((fresh) => {
                busy = false;
                if (!fresh) log('热力图数据可能未就绪，按当前读数继续', 'warn');
                evaluateMasteryPage(boxes);
            });
            return;
        }

        evaluateMasteryPage(boxes);
    }

    /**
     * 等热力图刷新到"最新"。
     * 判据：所有 popover 的百分比汇总成一个签名，连续两次采样一致即认为稳定。
     * 带次数上限，最多等约 3 秒。
     */
    function waitForFreshHeatmap() {
        const signature = () => Array.prototype.slice
            .call(document.querySelectorAll(SEL.popover))
            .map((p) => {
                const m = (p.innerText || '').match(/掌握度[：:]\s*(\d+)\s*%/);
                return m ? m[1] : '-';
            })
            .join(',');

        let last = signature();
        let stable = 0;
        return pollFor(30, 200, () => {
            const cur = signature();
            if (cur === last && cur.length > 10) stable += 1;
            else stable = 0;
            last = cur;
            return stable >= 2 ? true : null;
        }).then(() => true);
    }

    function evaluateMasteryPage(boxes) {
        points = scanKnowledgePoints(boxes);

        // 刚做完一轮回来：先结算上一个知识点
        const verdict = settleLastPoint();
        if (verdict === 'retry') {
            // 不达标，且还有轮次：立刻重做同一个知识点
            const same = points[currentPoint.index];
            if (same) {
                saveRuntime({ currentPoint });
                enterPointExam(currentPoint, boxes[currentPoint.index]);
                return;
            }
            log('找不到重做的知识点节点，放弃本轮重做', 'warn');
        }

        const mode = settings.mode === 'fill' ? 'fill' : 'auto';
        const threshold = settings.passThreshold;

        // ---- 进度 = 实时读取整张热力图 ----
        // 分母：需要考察的项目（总数 - 免考）
        // 分子：按模式判定"已完成"的项目
        const stats = computeProgress(points, mode, threshold);
        setProgress(stats.done, stats.total, `${mode === 'fill' ? '达标' : '已做'} 剩余 ${stats.total - stats.done}`);
        renderStats({
            needAnswer: stats.total,
            answered: stats.done,
            remain: stats.total - stats.done,
            pass: stats.exempt,
            gaveUp: stats.gaveUp,
            mode: mode === 'fill' ? '查漏补缺' : '自动',
        });
        renderStatus({ kind: 'on', label: `${mode === 'fill' ? '查漏' : '待作答'} ${stats.total - stats.done} / ${stats.total}` });
        log(`${mode === 'fill' ? '查漏补缺' : '自动'}模式：需考察 ${stats.total}，已完成 ${stats.done}，还剩 ${stats.total - stats.done}` +
            `（免考 ${stats.exempt}${stats.gaveUp ? `，已放弃 ${stats.gaveUp}` : ''}）`);

        // ---- 选目标 ----
        const target = mode === 'fill' ? pickFillTarget(points, threshold) : pickAutoTarget(points, threshold);

        if (!target) {
            const msg = mode === 'fill'
                ? `所有需考察的知识点掌握度均 ≥ ${threshold}%`
                : `需要考察的 ${stats.total} 个知识点已全部做过`;
            log(`${msg}，自动停止（免考 ${stats.exempt} 个）`, 'success');
            toast(mode === 'fill' ? '查漏补缺完成' : '全部知识点已补全', 'success');
            stopWork();
            return;
        }

        // ---- 进题 ----
        currentPoint = { name: target.name, index: target.index, percent: target.percent, rounds: 0, ts: Date.now() };
        retryCount = 0;
        saveRuntime({ currentPoint });
        log(`目标知识点「${target.name}」（当前掌握度 ${target.percent}%）`);
        enterPointExam(target, boxes[target.index]);
    }

    /**
     * 按模式计算进度。数据来自整张热力图的实时掌握度，而不是本地计数。
     *
     * 自动模式：分母 = 需考察项目数；分子 = 已经做过的（掌握度 > 0，即不再是遗漏点）
     * 查漏补缺：分母 = 需考察项目数；分子 = 掌握度 >= 阈值的
     *
     * 两种模式都会把"做满轮次已放弃"的项目算进分子——因为按用户要求，
     * 放弃了就当它完成，否则进度条永远差那么几个、看起来像没跑完。
     */
    function computeProgress(list, mode, threshold) {
        const exempt = list.filter((p) => p.exempt || p.passed).length;
        const total = list.length - exempt;
        const candidates = list.filter((p) => !(p.exempt || p.passed));
        let done;
        if (mode === 'fill') {
            done = candidates.filter((p) => (p.percent !== null && p.percent >= threshold) || isGaveUp(p)).length;
        } else {
            done = candidates.filter((p) => (p.percent !== null && p.percent > 0) || isGaveUp(p)).length;
        }
        const gaveUp = candidates.filter((p) => isGaveUp(p)).length;
        return { total, done, exempt, gaveUp };
    }

    /**
     * 结算「刚做完的那一轮」。
     *
     * 掌握度以**热力图里的实时值为准**（points 刚由 scanKnowledgePoints 刷新），
     * 分数页那份只作为参考/兜底——因为热力图才是课程统计的权威来源。
     *
     * 返回：
     *   'retry'   —— 查漏补缺模式下仍低于阈值，且没超过轮次上限 → 立刻重做
     *   'done'    —— 已达标 / 轮次用尽 / 自动模式 → 继续下一个
     *   'idle'    —— 没有待结算的知识点（刚开跑）
     */
    function settleLastPoint() {
        if (!currentPoint || !currentPoint.rounds) return 'idle';
        const rounds = currentPoint.rounds;
        const threshold = settings.passThreshold;
        const maxRounds = settings.maxRoundsPerPoint;
        const mode = settings.mode === 'fill' ? 'fill' : 'auto';

        // 以热力图的实时掌握度为准
        const live = points[currentPoint.index];
        const livePercent = live && live.percent !== null ? live.percent : null;
        const percent = livePercent !== null ? livePercent : currentPoint.percent;
        const pctText = percent === null ? '未知' : `${percent}%`;

        if (mode === 'auto') {
            log(`「${currentPoint.name}」第 ${rounds} 轮完成，掌握度 ${pctText}（自动模式，不重做）`);
            currentPoint = null;
            saveRuntime({ currentPoint: null });
            return 'done';
        }

        // 查漏补缺模式
        if (percent !== null && percent >= threshold) {
            log(`「${currentPoint.name}」第 ${rounds} 轮达到 ${percent}%（阈值 ${threshold}%），进入下一个`, 'success');
            currentPoint = null;
            saveRuntime({ currentPoint: null });
            return 'done';
        }

        // 做满轮次仍不达标 → 放弃，当作完成，不再碰它（防烧 token）
        const totalRounds = ledgerGet(currentPoint.name);
        if (rounds >= maxRounds || totalRounds >= maxRounds) {
            log(`「${currentPoint.name}」已做 ${Math.max(rounds, totalRounds)} 轮，掌握度 ${pctText} 仍未达 ${threshold}%，` +
                `已放弃并跳过（当作完成，不再消耗 token）`, 'warn');
            currentPoint = null;
            saveRuntime({ currentPoint: null });
            return 'done';
        }

        log(`「${currentPoint.name}」第 ${rounds} 轮 ${pctText}，低于 ${threshold}%，重做第 ${rounds + 1} 轮` +
            `（累计 ${totalRounds}/${maxRounds}）`, 'warn');
        // 同步最新掌握度，供下一轮参考
        currentPoint = Object.assign({}, currentPoint, { percent });
        return 'retry';
    }

    /**
     * 自动模式：按顺序取第一个「还没做过」的知识点。
     * "没做过" = 掌握度 0（灰色遗漏点）。做过但分数低的（粉/橙）不回头重做。
     * 已达轮次上限的一律排除。
     */
    function pickAutoTarget(list) {
        const cands = list.filter((p) =>
            !(p.exempt || p.passed) && p.percent !== null && p.percent <= 0 && !isGaveUp(p));
        return cands.length ? cands[0] : null;
    }

    /**
     * 查漏补缺模式：取掌握度低于阈值的知识点，**按列表顺序**从前往后做。
     * 一轮做完后，若列表里再也看不到低于阈值的项目，即自动停止。
     *
     * 已做满 maxRoundsPerPoint 轮仍不达标的会被 isGaveUp 排除——
     * 这就是"题目太难、AI 一直做错"时避免无限烧 token 的关键。
     */
    function pickFillTarget(list, threshold) {
        const cands = list.filter((p) =>
            !(p.exempt || p.passed) && p.percent !== null && p.percent < threshold && !isGaveUp(p));
        return cands.length ? cands[0] : null;
    }

    /**
     * 悬停灰块 → 等 popover → 点「提升掌握度」→ 跳 /exam。
     *
     * 关键点（实测）：灰块不能直接点，必须让鼠标"摸"上去才亮出按钮。
     * 站点用的是原生 mouseenter 监听，这里连发 mouseenter/mouseover/mousemove
     * 三种合成事件即可触发（与 CDP 真实鼠标移动等效，已验证）。
     */
    function enterPointExam(point, box) {
        if (!box) { log('找不到对应节点', 'error'); return; }
        busy = true;
        try {
            box.scrollIntoView({ block: 'center' });
            const nameEl = box.querySelector(SEL.masteryName) || box;
            ['mouseenter', 'mouseover', 'mousemove'].forEach((type) => {
                nameEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
            });
            log(`悬停知识点：「${point.name}」，等待按钮出现`);

            // popover 是异步渲染的，轮询找按钮（最多 3 秒）
            pollFor(30, 100, () => {
                const pops = Array.prototype.slice.call(document.querySelectorAll(SEL.popover))
                    .filter((p) => p.getBoundingClientRect().width > 0);
                for (const pop of pops) {
                    const btn = Array.prototype.slice.call(pop.querySelectorAll('span'))
                        .find((s) => s.innerText.trim() === SEL.upgradeBtnText);
                    if (btn) return btn;
                }
                return null;
            }).then((btn) => {
                if (!btn) {
                    log('没等到「提升掌握度」按钮，跳过这个知识点', 'warn');
                    busy = false;
                    markSkip(point);
                    return;
                }
                // 每次进题算一轮：本地计数 + 持久化账本都加 1
                const totalRounds = ledgerBump(point.name);
                currentPoint = Object.assign({}, currentPoint, {
                    rounds: ((currentPoint && currentPoint.rounds) || 0) + 1,
                });
                saveRuntime({ currentPoint });
                btn.click();
                log(`已点击「提升掌握度」，进入答题页（本次第 ${currentPoint.rounds} 轮，累计 ${totalRounds}/${settings.maxRoundsPerPoint} 轮）`);
                busy = false;
            });
        } catch (e) {
            busy = false;
            log(`进入知识点失败：${e.message}`, 'error');
        }
    }

    /* ---------------- 2. 答题页：读全部题目 → AI 作答 → 点击 → 提交 ---------------- */

    function runOnExamPage() {
        busy = true;
        const point = currentPoint || readPointFromUrl();
        if (!point) {
            busy = false;
            log('答题页但不知道是哪个知识点，跳过', 'warn');
            return;
        }

        const questions = readAllQuestions();
        if (!questions.length) {
            busy = false;
            log('答题页还没有题目，等待渲染', 'warn');
            return;
        }
        log(`进入答题页「${point.name}」，共 ${questions.length} 题：${questions.map((q) => q.type).join(' / ')}`);

        askAI(questions)
            .then((answerMap) => {
                if (!answerMap) {
                    busy = false;
                    log('AI 没给出可用答案，跳过本题', 'warn');
                    markSkip(point);
                    return null;
                }
                return applyAnswers(questions, answerMap).then((filled) => {
                    log(`已填写 ${filled} / ${questions.length} 题`);
                    if (filled === 0) {
                        busy = false;
                        log('一题都没填上，放弃本题', 'error');
                        markSkip(point);
                        return null;
                    }
                    return wait(400).then(() => {
                        log('点击「提交」');
                        return clickSubmit();
                    });
                });
            })
            .then(() => { busy = false; })
            .catch((e) => {
                busy = false;
                log(`答题流程异常：${e.message}`, 'error');
            });
    }

    /**
     * 一次性读出答题卡里的全部题目。
     * 实测：5 道题全部渲染在 DOM 里，只有当前题 display 非 none，
     * 所以可以一次读完交给 AI，不用来回翻页。
     *
     * 坑（实测）：选项字母的 class 不统一 ——
     *   多选题用 .ccc（"A."），单选题是裸 <span>（"A. "），判断题干脆没有字母。
     *   所以这里不读 DOM 里的字母，直接按选项顺序生成 A/B/C/D；
     *   判断题即为 A=对、B=错，与 AI 约定一致。
     */
    function readAllQuestions() {
        const LETTERS = 'ABCDEFGH';
        const out = [];
        Array.prototype.slice.call(document.querySelectorAll(SEL.examItem)).forEach((q, i) => {
            const typeEl = q.querySelector(SEL.questType);
            const titleEl = q.querySelector(SEL.questTitle);
            const opts = [];
            Array.prototype.slice.call(q.querySelectorAll(`${SEL.optionRadio}, ${SEL.optionCheckbox}`)).forEach((opt, oi) => {
                const textEl = opt.querySelector(SEL.optionText);
                const labelEl = opt.querySelector('.el-radio__label, .el-checkbox__label');
                const input = opt.querySelector('input');
                opts.push({
                    // 字母由选项顺序决定，不依赖 DOM 里的字母 class
                    letter: LETTERS.charAt(oi),
                    text: textEl ? textEl.innerText.trim() : (labelEl ? labelEl.innerText.trim() : ''),
                    element: opt,
                    input,
                });
            });
            out.push({
                index: i,
                type: typeEl ? typeEl.innerText.trim() : '',
                title: titleEl ? titleEl.innerText.trim() : '',
                options: opts,
            });
        });
        return out.filter((q) => q.title && q.options.length);
    }

    /**
     * 调 AI 作答。
     * 返回 { 题号: 'A' | 'ABD' } 形式的映射；失败返回 null。
     */
    function askAI(questions) {
        if (!settings.apiKey) {
            log('未填写 API Key，无法作答', 'error');
            toast('请先在面板填写 API Key', 'error');
            return Promise.resolve(null);
        }

        const payloadQuestions = questions.map((q, i) => ({
            index: i + 1,
            type: q.type,
            title: q.title,
            options: q.options.map((o) => `${o.letter}. ${o.text}`),
        }));

        const systemPrompt = [
            '你是一名答题助手。请根据题目内容给出正确答案。',
            '答题规则：',
            '- 单选题：只返回一个大写字母，例如 "A"。',
            '- 多选题：返回多个大写字母，按字母顺序拼接，例如 "ABD"。',
            '- 判断题：选项只有两个，第一个是「对」=A，第二个是「错」=B，只能回答 "A" 或 "B"。',
            '- 选项字母按题目给出的选项顺序排列，第一个选项是 A，第二个是 B，以此类推。',
            '只输出 JSON，不要任何解释、不要 markdown 代码块。',
            '输出格式必须严格为：{"answers":[{"index":1,"answer":"A"},{"index":2,"answer":"ABD"}]}',
        ].join('\n');

        const userPrompt = [
            `请作答以下 ${payloadQuestions.length} 道题。注意题型：${payloadQuestions.map((q) => `${q.index}是${q.type}`).join('，')}。`,
            `题目数据：\n${JSON.stringify(payloadQuestions, null, 1)}`,
        ].join('\n');

        return GM.request({
            url: settings.apiUrl,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${settings.apiKey}`,
            },
            data: JSON.stringify({
                model: settings.model,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
            timeout: 60000,
        })
            .then((res) => {
                if (res.status < 200 || res.status >= 300) {
                    throw new Error(`HTTP ${res.status}：${String(res.text).slice(0, 120)}`);
                }
                let body;
                try { body = res.json(); } catch (e) { throw new Error('返回不是合法 JSON'); }
                const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
                if (!content) throw new Error('返回里没有 choices[0].message.content');
                return parseAIAnswers(content, questions.length);
            })
            .catch((e) => {
                log(`AI 作答失败：${e.message || e}`, 'error');
                return null;
            });
    }

    /**
     * 解析 AI 返回的机审格式答案。
     * 兼容：纯 JSON / ```json 包裹 / 前后带解释文字。
     */
    function parseAIAnswers(content, expectedCount) {
        let text = String(content).trim();
        // 去掉 markdown 代码块
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        // 截取第一个 { 到最后一个 }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) text = text.slice(start, end + 1);

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`AI 返回不是合法 JSON：${String(content).slice(0, 100)}`);
        }
        const list = parsed && parsed.answers;
        if (!Array.isArray(list)) throw new Error('AI 返回缺少 answers 数组');

        const map = {};
        list.forEach((item) => {
            const idx = Number(item && item.index);
            const ans = String((item && item.answer) || '').toUpperCase().replace(/[^A-Z]/g, '');
            if (Number.isFinite(idx) && idx >= 1 && idx <= expectedCount && ans) map[idx] = ans;
        });
        const got = Object.keys(map).length;
        if (!got) throw new Error('AI 返回里没有有效答案');
        log(`AI 已作答 ${got} 题：${Object.keys(map).map((k) => `${k}→${map[k]}`).join('，')}`);
        return map;
    }

    /**
     * 勾选/取消一个选项（单次点击，不做等待）。
     *
     * 实测三个坑，必须同时处理：
     *  1. 必须点 input 本身，不能点 label —— 对 el-radio 点 label.click() 完全不生效
     *     （checked 始终 false，答题卡也不变），点 input 才真正改状态。
     *  2. click 是"切换"语义，已勾选的再点会取消，所以先判断状态再点（幂等）。
     *  3. Vue 的 checked 是异步更新的，点击后同一调用栈里读 input.checked 还是旧值。
     */
    function toggleOption(opt, shouldCheck) {
        const isChecked = !!(opt.input && opt.input.checked);
        if (shouldCheck === isChecked) return false;    // 状态已正确，不动
        const target = opt.input || opt.element;
        target.click();
        return true;
    }

    /**
     * 按答案点击选项，返回成功填写的题数。返回 Promise<number>。
     *
     * ⚠️ 关键坑（实测踩到过：多选题 AI 给了 ACD，结果只勾上 AD，C 凭空消失）：
     *   绝不能"同步连点"做完所有选项。Vue 的响应式在两次点击之间来不及 flush，
     *   中间那个选项会被吞掉。
     *
     *   三轮重复对照实验（目标 ACD）：
     *     同步连点 input.click()        → AD / AD / AD   ❌ 稳定丢中间项
     *     逐个点 + 250ms 间隔            → ACD / ACD / ACD ✓
     *     完整鼠标事件链 + 80ms          → ACD / ACD / ACD ✓
     *
     *   所以这里改成串行：每次点击后等 DOM 真正反映出来，再处理下一个选项。
     */
    function applyAnswers(questions, answerMap) {
        const OPTION_GAP = 120;   // 每个选项点击之间的间隔，给 Vue 留出 flush 时间
        const VERIFY_TRIES = 3;   // 每题校验/补点的最大轮次

        /** 等下一次渲染（两帧 + 小延时，确保 watcher 已跑完） */
        const settle = () => new Promise((r) => {
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, OPTION_GAP)));
        });

        /** 某题的目标状态是否已达成 */
        const isQuestionDone = (q, want) => q.options.every((opt) => {
            if (want.indexOf(opt.letter) < 0) return true;
            return !!(opt.input && opt.input.checked);
        });

        /** 逐题串行填写，每题最多补点 VERIFY_TRIES 轮 */
        const fillOne = (q, want, attempt) => {
            // 同步点这一题里所有状态不对的选项（题内选项之间也留间隔）
            const needToggle = q.options.filter((opt) => {
                const expected = want.indexOf(opt.letter) >= 0;
                return !!(opt.input && opt.input.checked) !== expected;
            });
            if (!needToggle.length) return Promise.resolve(true);

            return needToggle.reduce(
                (chain, opt) => chain.then(() => {
                    toggleOption(opt, want.indexOf(opt.letter) >= 0);
                    return settle();
                }),
                Promise.resolve()
            ).then(() => {
                if (isQuestionDone(q, want)) return true;
                if (attempt >= VERIFY_TRIES) return false;
                return fillOne(q, want, attempt + 1);
            });
        };

        // 逐题串行（題与题之间也串行，避免整页同时触发大量响应式更新）
        return questions.reduce(
            (chain, q, i) => chain.then((acc) => {
                const answer = answerMap[i + 1];
                if (!answer) return acc;
                const want = answer.split('');
                return fillOne(q, want, 1).then((ok) => {
                    if (!ok) {
                        acc.failed.push(`${i + 1}(${answer})`);
                        log(`第 ${i + 1} 题答案 ${answer} 没能完全勾上`, 'warn');
                    } else {
                        acc.filled += 1;
                    }
                    return acc;
                });
            }),
            Promise.resolve({ filled: 0, failed: [] })
        ).then((acc) => acc.filled);
    }

    /**
     * 点提交；若出现「还有 N 道题未作答」弹窗，点「确认提交」。
     */
    function clickSubmit() {
        const btn = document.querySelector(SEL.submitBtn);
        if (!btn) { log('找不到提交按钮', 'error'); return Promise.resolve(false); }
        btn.click();
        // 等弹窗出现（未答完时才有）
        return pollFor(20, 150, () => {
            const dlg = document.querySelector(SEL.confirmDialog);
            if (!dlg || dlg.getBoundingClientRect().width === 0) return null;
            const confirm = Array.prototype.slice.call(dlg.querySelectorAll('.btn'))
                .find((b) => b.innerText.trim() === SEL.confirmSubmitText);
            return confirm || null;
        }).then((confirm) => {
            if (confirm) {
                log('出现未作答提示，点击「确认提交」');
                confirm.click();
            }
            return true;
        });
    }

    /* ---------------- 3. 分数页：记录本轮结果，点「返回」回列表 ---------------- */

    function runOnResultPage() {
        busy = true;
        const rateEl = document.querySelector(SEL.scoreRate);
        const rawRate = rateEl ? rateEl.innerText.trim() : '';
        const rate = parseInt(rawRate, 10);
        const percent = Number.isFinite(rate) ? rate : null;
        const pointName = (currentPoint && currentPoint.name) || '';
        log(`「${pointName}」第 ${(currentPoint && currentPoint.rounds) || '?'} 轮完成，掌握度 ${percent === null ? '未知' : percent + '%'}，准备返回`);

        // 只记录成绩；rounds 已在 enterPointExam 进题时递增过，这里不能再加，
        // 否则每轮会被算两次（实测踩过：2→4→6 跳号）。
        const history = (currentPoint && currentPoint.history) || [];
        history.push(percent);
        currentPoint = Object.assign({}, currentPoint, { percent, history });

        const back = document.querySelector(SEL.backBtn);
        if (!back) {
            busy = false;
            log('找不到返回按钮，使用 history.back 兜底', 'warn');
            history.back();
            return;
        }
        setTimeout(() => {
            busy = false;
            // 注意：这里不清 currentPoint！回列表后要用它判断是否达标 / 是否要重做
            saveRuntime({ currentPoint });
            back.click();      // 点页面上的返回按钮，避免多退回
            log('已点击「返回」，回到知识点列表');
        }, Math.max(200, settings.afterSubmitDelay));
    }

    /* ---------------- 工具函数 ---------------- */

    function wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /**
     * 轮询直到 fn() 返回真值，或到达次数上限。
     * 这是本脚本唯一的"等待 DOM"手段，所有等待都带次数上限，不会死等。
     */
    function pollFor(times, interval, fn) {
        return new Promise((resolve) => {
            let n = 0;
            const step = () => {
                let v;
                try { v = fn(); } catch (e) { v = null; }
                if (v) { resolve(v); return; }
                n += 1;
                if (n >= times) { resolve(null); return; }
                setTimeout(step, interval);
            };
            step();
        });
    }

    /**
     * 扫描知识点，并读出**每个知识点的精确掌握度**。
     *
     * 实测（关键发现）：页面上每个知识点都有一个对应的 popover 节点，
     * 常驻在 DOM 里（只是 display 为 none），文本形如：
     *     「人工智能的基本概念 掌握度：60% 提升掌握度」
     *     「 该知识点为免考知识点，不计入掌握度。 」
     * **不需要悬停**，直接按 DOM 顺序遍历 popover 即可拿到全部 88 条的精确百分比，
     * 实测耗时 3ms。popover 顺序与 li.item-box 顺序完全一致。
     *
     * 颜色 class 只用来做交叉校验 / 兜底（实测对应关系）：
     *   green  rgb(140,229,162)  掌握较好  掌握度 >= 80
     *   origin rgb(255,203,102)  掌握一般  掌握度 60-79
     *   pink   rgb(255,162,162)  薄弱点    掌握度 1-59（实测 20/40）
     *   gray   rgb(204,204,204)  遗漏点    掌握度 0
     *   blue   rgb(143,208,255)  免考      不计入
     */
    function scanKnowledgePoints(boxes) {
        const list = Array.prototype.slice.call(boxes);

        // 1) 一次性读出所有 popover 的百分比（按 DOM 顺序）
        const popovers = Array.prototype.slice.call(
            document.querySelectorAll(SEL.popover)
        );
        const popData = popovers.map((p) => {
            const text = (p.innerText || '').replace(/\s+/g, ' ').trim();
            const pctMatch = text.match(/掌握度[：:]\s*(\d+)\s*%/);
            const exempt = text.indexOf('免考') >= 0 || text.indexOf('不计入') >= 0;
            const nameMatch = text.match(/^(.*?)\s*掌握度/);
            return {
                pct: pctMatch ? Number(pctMatch[1]) : null,
                exempt,
                name: nameMatch ? nameMatch[1].trim() : '',
            };
        });

        // 2) 与知识点节点按顺序配对；数量对不上时退回用名字匹配
        const useByIndex = popData.length === list.length;

        return list.map((box, index) => {
            const nameEl = box.querySelector(SEL.masteryName);
            const name = nameEl ? nameEl.innerText.trim() : '';

            let info = useByIndex ? popData[index] : null;
            if (!info || (info.name && name && info.name.indexOf(name) < 0 && name.indexOf(info.name) < 0)) {
                const byName = popData.find((d) => d.name && (d.name === name || d.name.indexOf(name) >= 0));
                if (byName) info = byName;
            }

            const passed = box.classList.contains(SEL.masteryPass);
            const empty = box.classList.contains(SEL.masteryEmpty);
            const pink = box.classList.contains(SEL.masteryPink);
            const origin = box.classList.contains(SEL.masteryOrigin);
            const green = box.classList.contains(SEL.masteryGood);

            // 精确百分比：popover 优先；读不到再按颜色兜底
            let percent;
            if (info && info.pct !== null) percent = info.pct;
            else if (passed) percent = null;          // 免考无意义
            else if (green) percent = 100;
            else if (origin) percent = 60;
            else if (pink) percent = 20;
            else if (empty) percent = 0;
            else percent = 0;

            return {
                index,
                name,
                empty, passed, pink, origin, green,
                percent,
                exempt: passed || (info ? info.exempt : false),
            };
        });
    }

    function readPointFromUrl() {
        const name = new URLSearchParams(location.search).get('name');
        return name ? { name, index: -1 } : null;
    }

    function markSkip(point) {
        log(`跳过知识点「${point.name}」`, 'warn');
    }

    /** 渲染统计行：需考察 / 已完成 / 剩余 / 免考（+ 已放弃） */
    function renderStats(s) {
        const box = document.getElementById(id('stats'));
        if (!box) return;
        const cells = [
            ['需考察', s.needAnswer],
            ['已完成', s.answered],
            ['剩余', s.remain],
        ];
        // 有放弃的项目时单独显示，让用户知道进度条里那几个是"做不出来的"
        if (s.gaveUp) cells.push(['已放弃', s.gaveUp]);
        cells.push(['免考', s.pass]);
        box.innerHTML = cells
            .map(([label, v]) => `<span class="${el('stat')}"><b>${v}</b>${label}</span>`)
            .join('');
        const hint = document.getElementById(id('modeHint'));
        if (hint && s.mode) {
            hint.textContent = s.mode === '查漏补缺'
                ? `查漏补缺：把掌握度 < ${settings.passThreshold}% 的知识点反复做到达标（单点最多 ${settings.maxRoundsPerPoint} 轮，超了跳过）`
                : `自动：按顺序把还没做过的知识点全部做完一遍（单点最多 ${settings.maxRoundsPerPoint} 轮）`;
        }
    }

    /**
     * 被防水墙拦截时返回 true。
     *
     * 坑（实测）：验证码元素是**常驻挂载**的，平时也在 DOM 里，但用两种手法藏着：
     *   #captchaYidun    宽 1284（几乎全屏）但 **高度 0**，是空容器
     *   turing iframe    300x150，但 y = -1000000（挪到屏幕外）
     * 所以不能只看"宽度 > 0"，必须判断**真的在视口里有高度**。
     */
    function captchaBlocking() {
        const inViewport = (r) =>
            r.height > 0 && r.width > 0 &&
            r.top < window.innerHeight && r.bottom > 0;

        const node = document.querySelector(SEL.captchaNode);
        if (node) {
            const r = node.getBoundingClientRect();
            // 弹层真正出现时高度会明显大于 0，并且里面有子节点（滑块）
            if (inViewport(r) && r.height > 60 && node.children.length) return true;
        }

        const frame = document.querySelector(SEL.captchaFrame);
        if (frame) {
            const r = frame.getBoundingClientRect();
            // 常驻模板是 300x150 且被挪到 y=-1000000，这里用视口判断排除它
            if (inViewport(r)) return true;
        }

        return false;
    }

    /**
     * 刷新掌握度进度条（不启动流程）。
     * 用于：脚本加载后、切换模式、手动扫描、页面 DOM 变化后。
     *
     * 进度条完全由热力图的实时掌握度算出，不做本地累加：
     *   分母 = 需考察项目数（总数 - 免考）
     *   分子 = 自动模式看"做过没有"、查漏补缺模式看"是否达标"
     */
    function refreshMasteryStats() {
        const boxes = document.querySelectorAll(SEL.masteryBox);
        if (!boxes.length) return false;
        points = scanKnowledgePoints(boxes);

        const mode = settings.mode === 'fill' ? 'fill' : 'auto';
        const stats = computeProgress(points, mode, settings.passThreshold);
        const remain = stats.total - stats.done;

        setProgress(stats.done, stats.total, `${mode === 'fill' ? '达标' : '已做'} 剩余 ${remain}`);
        renderStats({
            needAnswer: stats.total,
            answered: stats.done,
            remain,
            pass: stats.exempt,
            gaveUp: stats.gaveUp,
            mode: mode === 'fill' ? '查漏补缺' : '自动',
        });
        return true;
    }

    /* ================================================================
     *  9. 启动入口
     * ================================================================ */

    function boot() {
        injectStyles();
        ensurePanel();
        GM.registerMenuCommand('显示/隐藏面板', () => {
            const panel = document.getElementById(id('panel'));
            if (!panel) { ensurePanel(); return; }
            panel.style.display = panel.style.display === 'none' ? '' : 'none';
        });
        GM.registerMenuCommand('打开运行日志', ensureLogPanel);
        GM.registerMenuCommand('刷新进度条', () => {
            if (!refreshMasteryStats()) { toast('当前页没有知识点，请到掌握度页使用', 'warn'); return; }
            const mode = settings.mode === 'fill' ? 'fill' : 'auto';
            const stats = computeProgress(points, mode, settings.passThreshold);
            const below = points.filter((p) => !(p.exempt || p.passed) && p.percent !== null && p.percent < settings.passThreshold).length;
            log(`刷新进度：需考察 ${stats.total}，已完成 ${stats.done}，剩余 ${stats.total - stats.done}` +
                `（免考 ${stats.exempt}，已放弃 ${stats.gaveUp}）；低于 ${settings.passThreshold}% 的有 ${below} 个`, 'success');
            toast(`已考察 ${stats.done}/${stats.total}`, 'success');
        });
        GM.registerMenuCommand('查看作答轮次账本', () => {
            const ledger = loadLedger();
            const names = Object.keys(ledger);
            if (!names.length) { log('轮次账本为空（还没有开始作答）'); toast('轮次账本为空'); return; }
            const lines = names
                .sort((a, b) => ledger[b] - ledger[a])
                .map((n) => `${n}: ${ledger[n]}/${settings.maxRoundsPerPoint} 轮${ledger[n] >= settings.maxRoundsPerPoint ? '（已放弃）' : ''}`);
            log(`轮次账本（共 ${names.length} 项）：\n${lines.join('\n')}`);
            toast(`共 ${names.length} 个知识点有作答记录`);
        });
        GM.registerMenuCommand('清空作答轮次账本', () => {
            ledgerReset();
            log('已清空作答轮次账本，所有知识点重新计算轮次', 'warn');
            toast('已清空轮次账本');
            refreshMasteryStats();
        });

        log(`${APP_NAME} v${SCRIPT_VERSION} 已加载`);
        console.log(`[${APP_NAME}] version=${SCRIPT_VERSION}`, { settings });

        // 跨页面接续：从掌握度页跳来答题页/分数页时，恢复"运行中"状态
        const rt = loadRuntime();
        if (rt.currentPoint) currentPoint = rt.currentPoint;
        if (rt.running && settings.enabled) {
            log('检测到上次运行未结束，自动接续');
            startWork();
            return;
        }

        // 掌握度页的知识点是异步渲染的，@run-at document-idle 时可能还没出来。
        // 用 MutationObserver 等它们出现后再刷一次统计，而不是干等。
        if (isMasteryPage()) {
            refreshMasteryStats();
            if (!document.querySelectorAll(SEL.masteryBox).length) {
                const mo = new MutationObserver(() => {
                    if (document.querySelectorAll(SEL.masteryBox).length) {
                        mo.disconnect();
                        refreshMasteryStats();
                    }
                });
                mo.observe(document.body, { childList: true, subtree: true });
                // 观察器也要有退出条件：20 秒后自动断开
                setTimeout(() => mo.disconnect(), 20000);
            }
        }

        // 暴露一个只读调试入口，方便在控制台排查（不污染页面全局太多）
        GM.pageWindow.__ZHIHUISHU_KNOWLEDGE_MASTERY__ = {
            version: SCRIPT_VERSION,
            get settings() { return { ...settings }; },
            logs: () => logEntries.slice(),
            sel: SEL,
            ensurePanel,
            toast,
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
