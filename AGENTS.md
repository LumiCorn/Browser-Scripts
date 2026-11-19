# AGENTS.md

给 AI 编码代理与人类协作者的仓库指南。**开始任何工作前请先读本文件。**

---

## 1. 项目概览

`Browser-Scripts` 是一个**浏览器用户脚本（UserScript）合集**，适配 ScriptCat（脚本猫）与 Tampermonkey（油猴）。

- 仓库：https://github.com/LumiCorn/Browser-Scripts （**public**）
- 每个脚本一个子目录，各自带 `README.md`（可选 `docs/`）
- 纯原生 JavaScript，**无构建步骤**，单文件 IIFE，直接粘贴进脚本管理器即可运行

### 目录结构

```
Browser-Scripts/
├── AGENTS.md                          # 本文件
├── .gitignore
├── README.md                          # 总索引 + 一键安装链接
├── Material-Design-Constitution/      # M3 设计规范（多项目共用，勿改）
│   ├── m3-web-vanilla/                #   含 m3-tokens.css 设计令牌
│   ├── material-design-3-color/
│   └── material-design-3-components/
├── ZhiHuiShu-WenDa-Autoscript/        # 智慧树问答自动化 v3.5.0（最复杂，3093 行）
├── ZhiHuiShu-Title-Status/            # 智慧树标题状态 v1.3.0（444 行，纯执行无 UI）
└── Userscript-Template/               # 脚本通用模板 v1.1.0（794 行）
```

### 当前脚本

| 脚本 | 版本 | 主文件 | 说明 |
| --- | --- | --- | --- |
| 智慧树问答自动化 | **3.5.0** | `ZhiHuiShu-WenDa-Autoscript/zhihuishu-qa-automation.user.js` | AI 自动答题/提问，父子页面架构，M3 悬浮面板 |
| 智慧树标题状态 | **1.3.0** | `ZhiHuiShu-Title-Status/zhihuishu-title-status.user.js` | 改标签页标题为「位置 - 用户名」，无 UI |
| UserScript 模板 | **1.1.0** | `Userscript-Template/userscript-template.user.js` | 可复用骨架，复制开新项目 |

---

## 2. 🔧 调试浏览器（Chrome + CDP）

本仓库的脚本**必须实测验证**，很多问题（选择器失效、DOM 污染、时序竞态）静态看代码发现不了。为此维护一个独立的可调试 Chrome 实例。

### 2.1 为什么需要独立 profile

Chrome 136+ 有两条关键安全限制，**不知道会浪费大量时间**：

1. **默认 profile 上 `--remote-debugging-port` 会被静默忽略** —— 必须配合 `--user-data-dir` 才能开启 CDP。
2. **`--load-extension` 已被禁用** —— 无法用命令行加载解包扩展。

因此调试环境使用**独立 profile + 企业策略装扩展**。

### 2.2 一键启动

**Windows PowerShell：**

```powershell
$chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = "$env:LOCALAPPDATA\Temp\dsh-userscript-profile\profile"

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  '--remote-debugging-port=9222',
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
)
```

**首次使用需先安装 Tampermonkey**（走企业策略，无需管理员权限）：

```powershell
$key = 'HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '1' `
  -Value 'dhdgffkkebhmkfjojejmpbldmpobfkfo;https://clients2.google.com/service/update2/crx'
```

> ⚠️ 该策略**全局生效**，会影响同一台机器上所有 Chrome 用户配置（包括日常用的正式版）。不用时请删除该项。

**验证 CDP 已就绪：**

```powershell
(Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing).Content
```

返回 JSON 含 `"Browser": "Chrome/..."` 即成功。

### 2.3 关闭调试实例（不要误杀正式版）

**只关这个 profile 的进程**，绝不按 `chrome.exe` 名字批量 kill：

```powershell
$profile = "$env:LOCALAPPDATA\Temp\dsh-userscript-profile\profile"
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match [regex]::Escape($profile) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

### 2.4 通过 CDP 连接

Node 18+ 内置 `fetch` 与 `WebSocket`，**无需安装 puppeteer/playwright**：

```javascript
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('zhihuishu'));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let seq = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

const r = await send('Runtime.evaluate', {
  expression: 'document.title', returnByValue: true
});
console.log(r.result.result.value);
```

### 2.5 ⚠️ CDP 调试的重要局限性

**这是本仓库最容易踩坑的地方，务必理解：**

| 问题 | 说明 |
| --- | --- |
| **`GM_*` API 不存在** | 通过 CDP `Runtime.evaluate` 注入的代码运行在**页面主世界**，`GM_setValue` / `GM_getValue` / `GM_xmlhttpRequest` 全部是 `undefined`。只能验证**降级后的行为**，无法验证真实 GM 存储与跨标签通信。 |
| **`isTrusted` 无法伪造** | 脚本合成的事件 `event.isTrusted` 恒为 `false`。站点若检查该属性，任何脚本都点不动它。 |
| **页面会污染全局内置对象** | 实测 `lc.zhihuishu.com`（直播页）把全局 `Map` 重写成了只有 `put()` 的自定义实现，导致 `new Map().has` 为 `undefined`。**脚本里不要依赖 `Map`/`Set` 等可能被打劫的全局构造器**，必要时用数组。 |
| **站点会抢标题** | 智慧树首页在约 900ms 时用 JS 改回自己的 `document.title`。拦截必须改 **`Document.prototype`** 上的访问器；装在 `document` 实例上无效（站点走原型链，会绕过）。 |
| **SPA 路由不重载页面** | 切换 `location.hash` 不会重新执行脚本，必须依赖 `hashchange` / `popstate` / `MutationObserver`。 |
| **context 复用会串测试** | 同一标签页反复注入会**叠加多个脚本实例**。切换测试场景时用 `Target.createTarget` 开新标签页，测完 `Target.closeTarget`。 |

**能可靠验证的：** DOM 选择器是否命中、Vue 实例数据结构（`__vue__.$data`）、页面标题、样式渲染、事件时序、异常抛出。
**不能验证的：** GM 存储行为、跨标签消息、脚本管理器 API 权限。

### 2.6 常用 CDP 操作

```javascript
// 新建标签页（推荐，避免 context 污染）
const { result } = await send('Target.createTarget', { url: 'https://...' });

// 导航
await send('Page.navigate', { url: 'https://...' });

// 注入并捕获异常
const r = await send('Runtime.evaluate', { expression: code });
if (r.result.exceptionDetails) console.error(r.result.exceptionDetails);

// 列出所有 target（含扩展 service worker）
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
```

**调试脚本请用 `_` 前缀命名**（如 `_verify.js`），用完删除，不要提交。

---

## 3. 开发约定

### 3.1 必须遵守

1. **改完必须 `node --check <file>.user.js`** —— 无构建流程，靠它兜住语法错误。
2. **版本号两处同步** —— 元数据 `// @version` 与代码里的 `SCRIPT_VERSION` 常量必须一致。
3. **注入 DOM 的 class/id 必须加前缀** —— 问答脚本用 `zhs-`，模板用 `ust-`，防止与宿主页面（Element UI）样式冲突。
4. **所有定时器必须有退出条件** —— 次数上限或超时，并在停止逻辑里清理。
5. **长流程要配防重入锁** —— 参考问答脚本的 `requestLock` / `askLock` / `waitingForChild`。
6. **每个关键决策点打 `console.log`** —— 变量名用中文关键词便于过滤排查。

### 3.2 安全红线

- **绝不提交任何 API Key、Cookie、Token。** 凭据功能一律做成面板里的用户自填项，存 `GM_setValue`。
- 提交前自查：`git grep --cached -l -E 'sk-[A-Za-z0-9]{20,}'`，应无输出。
- `.gitignore` 已排除 `.env*`、`*.storage.json`、`*.options.json`、`scriptcat-backup*.zip`、`.acl-recovery/`。

### 3.3 编辑中文文件的坑

本仓库大量中文内容。**不要用 PowerShell 的 `Set-Content` / 重定向写中文文件**——会把 UTF-8 读成 GBK 再二次编码，产生乱码且丢失换行。用文件编辑工具，或显式指定编码：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

改完验证：文件首行应正常显示中文，`node --check` 通过。

---

## 4. 各脚本要点

### 4.1 智慧树问答自动化（最复杂）

**架构：父子页面**

- **父页面** = 问答列表页（`#/web/home/...`）：同步、跳题、倒计时、调度
- **子页面** = 题目详情页（`#/web/questionDetail/...`）：只答题，答完通过 GM 存储汇报并自杀

**关键机制**

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| 绕过弹窗拦截 | `openQuestionInNewTab` | 临时替换 `window.open` 截获 URL，再用 `GM_openInTab` 打开 |
| 同步官方已答 | `syncAnsweredFromMyJoin` | hash 跳转到「我的参与」读 Vue 数据再跳回，页面不重载 |
| 子页面回传官方数字 | `applyChildOfficial` | **只升不降**合并，防止旧数据把进度拖回去 |
| 停止条件 | `isTargetReached` | **双保险**：官方 ≥ 目标(50) 或 脚本计数 ≥ 安全上限(100) |
| 提问弹窗定位 | `findAskDialog` | 三级降级，因为 `aria-modal` 可能延迟出现 |
| 增强点击 | `simulateClick` | 派发完整指针事件链；仍受 `isTrusted` 限制 |

**已知坑**

- 子页面的 `.user-name` 是「课程问答小助手」（官方助教），**不是登录用户**，已用黑名单排除。
- 每答满 5 题自动刷新页面会导致列表空白，**该逻辑已在 v3.0.0 移除**，不要加回来。

### 4.2 智慧树标题状态

- 纯执行，**不创建任何 DOM**，唯一副作用是改 `document.title`。
- 用户名来源优先级：**`CASLOGC` cookie**（域 `.zhihuishu.com`，全子域可读，含 `realName`）→ DOM `.user-logo_name` → GM 缓存。
- 标题拦截必须改 `Document.prototype` 的 `title` 访问器，**不改** `document` 实例。
- 不要依赖 `Map`（`lc` 域会污染它）。

### 4.3 模板

复制整个目录开新项目，改三处：元数据、`SCRIPT_VERSION` / `APP_NAME` / `PREFIX`、业务钩子（`startWork` / `stopWork` / `tick`）。

---

## 5. 发布与安装

### 5.1 安装链接

**优先 jsDelivr**（`Content-Type: application/javascript`，管理器识别稳定，国内可访问）：

```
https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/<子目录>/<文件名>.user.js
```

**GitHub raw 备用**（国内时通时断；且返回 `text/plain` + `nosniff`，个别情况不弹安装框）：

```
https://raw.githubusercontent.com/LumiCorn/Browser-Scripts/main/<子目录>/<文件名>.user.js
```

三个脚本的元数据都声明了 `@downloadURL` / `@updateURL`，管理器会自动检查更新。

### 5.2 CDN 缓存

- **raw**：`Cache-Control: max-age=300`（5 分钟）
- **jsDelivr `@main`**：最长 12 小时

**验证刚推送的内容时，用 commit SHA 锁定地址**，否则会读到旧缓存：

```
https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@<40位SHA>/<子目录>/<文件名>.user.js
```

### 5.3 git 推送的坑

本机 **git 协议（`git push` / `git fetch`）经常被阻断**（`Connection was reset`），但 **GitHub API 稳定可用**。

推送失败时的替代方案：

```powershell
# 用 API 提交单个文件（需先取现有 sha）
$enc = [uri]::EscapeDataString($path) -replace '%2F','/'
$sha = gh api "repos/LumiCorn/Browser-Scripts/contents/$enc" --jq '.sha'
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path $localFile)))
@{
  message = 'feat: ...'
  content = $b64
  sha     = $sha
  branch  = 'main'
} | ConvertTo-Json -Compress | Set-Content $env:TEMP\p.json -Encoding UTF8
gh api -X PUT "repos/LumiCorn/Browser-Scripts/contents/$enc" --input $env:TEMP\p.json
```

> 走 API 后本地与远程的 **commit 历史会分叉**（内容一致，记录不同）。网络恢复后 `git pull --rebase` 对齐。

---

## 6. 新增脚本流程

1. 根目录新建文件夹，名 = 脚本英文名（短横线风格，如 `My-New-Script`）。
2. 从 `Userscript-Template/` 复制 `userscript-template.user.js` 并改名为 `<name>.user.js`。
3. 修改元数据：`@name` / `@version` / `@description` / `@match`，**以及 `@downloadURL` / `@updateURL` 指向新路径**。
4. 改常量 `SCRIPT_VERSION` / `APP_NAME` / `PREFIX`。
5. 写 `README.md`。
6. 根 `README.md` 的脚本列表与一键安装表各加一行。
7. `node --check` 通过后，用调试 Chrome 实测。
8. 提交时确认无敏感信息。

---

## 7. 排障速查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| CDP 连不上 9222 | 未带 `--user-data-dir` | 按 2.2 启动，确认是独立 profile |
| CDP 能连但 `GM_*` 全是 undefined | 正常现象 | 见 2.5，这是主世界注入的限制 |
| 脚本在某子域完全不执行 | 全局内置对象被站点打劫 | 用 `Runtime.evaluate` 看 `exceptionDetails`，改掉 `Map`/`Set` 依赖 |
| 注入后行为混乱 | 同标签页重复注入 | 用 `Target.createTarget` 开新标签 |
| 改文件后中文变乱码 | 用了 `Set-Content` | 重写文件，见 3.3 |
| 推送 `Connection was reset` | 网络阻断 | 用 API 提交，见 5.3 |
| 刚推送的内容读不到新版本 | CDN 缓存 | 用 SHA 锁定地址验证 |
| 面板不出现 / 找不到 | 面板被拖出视口 | 点「📌 回归位置」按钮；位置记忆存 `panelPos` |

---

## 8. 快速自检清单

提交前逐项确认：

- [ ] `node --check` 通过
- [ ] `@version` 与 `SCRIPT_VERSION` 一致
- [ ] 无硬编码 Key（`git grep --cached 'sk-'`）
- [ ] 中文未乱码
- [ ] `@downloadURL` / `@updateURL` 指向正确路径
- [ ] 根 README 版本号已同步
- [ ] 已用调试 Chrome 实测（或明确说明未实测）
