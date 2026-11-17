// ==UserScript==
// @name         UserScript 模板
// @namespace    https://github.com/LumiCornX/Browser-Scripts
// @version      1.0.0
// @description  浏览器脚本通用模板：Material Design 3 悬浮面板（可拖拽/折叠/位置记忆）、Toast、运行日志、设置读写、GM API 兼容层。复制本文件即可开新脚本。
// @author       LumiCornX
// @match        *://*/*
// @run-at       document-idle
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

    const SCRIPT_VERSION = '1.0.0';
    const APP_NAME = 'UserScript 模板';
    const APP_ICON = '🧩';

    // 所有注入 DOM 的 id / class 统一前缀，防止与宿主页面冲突
    const PREFIX = 'ust';
    const el = (name) => `${PREFIX}-${name}`;
    const id = (name) => `${PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;

    // 面板可配置项：复制模板后按需增删，设置区会自动渲染
    const DEFAULTS = {
        enabled: true,
        intervalSec: 5,
        apiKey: '',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
    };

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
                    <button class="${el('segment')}" data-mode="manual">手动</button>
                </div>
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
                <div class="${el('actions')}">
                    <button class="${el('btn')} primary" id="${id('mainBtn')}">开始</button>
                    <button class="${el('btn')} ghost" id="${id('logBtn')}">日志</button>
                </div>
                <details class="${el('settings')}">
                    <summary>设置</summary>
                    <div class="${el('settings-fields')}">
                        <div class="${el('field')}">
                            <label>API Key</label>
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
                                <label>间隔(秒)</label>
                                <input type="number" id="${id('intervalInput')}" min="1" max="600">
                            </div>
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
        document.querySelectorAll(`.${el('segment')}`).forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === (settings.enabled ? 'auto' : 'manual'));
        });
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

        // Segmented Button：模式切换
        panel.querySelectorAll(`.${el('segment')}`).forEach((btn) => {
            btn.addEventListener('click', () => {
                settings.enabled = btn.dataset.mode === 'auto';
                saveSettings(settings);
                panel.querySelectorAll(`.${el('segment')}`)
                    .forEach((b) => b.classList.toggle('active', b === btn));
                toast(settings.enabled ? '已切换到自动模式' : '已切换到手动模式');
            });
        });

        // 主按钮：开始/停止（业务逻辑接在这里）
        panel.querySelector(`#${id('mainBtn')}`).addEventListener('click', () => {
            settings.enabled = !settings.enabled;
            saveSettings(settings);
            syncPanelFromSettings();
            renderStatus();
            toast(settings.enabled ? '已开始' : '已停止');
            onToggle(settings.enabled); // ← 业务钩子
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
     *  8. 业务钩子 —— 复制模板后在这里写自己的逻辑
     * ================================================================ */

    // 主按钮切换时调用
    function onToggle(enabled) {
        if (enabled) startWork(); else stopWork();
    }

    let workTimer = null;

    function startWork() {
        stopWork();
        log('工作循环启动');
        renderStatus({ kind: 'on', label: '运行中' });
        // 示例：按设置的间隔执行
        workTimer = setInterval(() => {
            if (!settings.enabled) { stopWork(); return; }
            tick();
        }, Math.max(1, settings.intervalSec) * 1000);
    }

    function stopWork() {
        if (workTimer) {
            clearInterval(workTimer);
            workTimer = null;
            log('工作循环已停止');
        }
        renderStatus({ kind: 'off', label: '已停止' });
    }

    let tickCount = 0;
    function tick() {
        tickCount += 1;
        log(`第 ${tickCount} 次执行`);
        setProgress(tickCount, 100, '示例进度');
        // TODO: 你的业务逻辑写在这里
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

        log(`${APP_NAME} v${SCRIPT_VERSION} 已加载`);
        console.log(`[${APP_NAME}] version=${SCRIPT_VERSION}`, { settings });

        // 暴露一个只读调试入口，方便在控制台排查（不污染页面全局太多）
        GM.pageWindow.__USERSCRIPT_TEMPLATE__ = {
            version: SCRIPT_VERSION,
            get settings() { return { ...settings }; },
            logs: () => logEntries.slice(),
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
