# UserScript 模板

浏览器脚本通用模板，基于 ScriptCat / Tampermonkey 运行。**复制本目录即可开新脚本**，只需修改元数据和业务钩子。

**当前版本：v1.1.0**

## 包含什么

| 模块 | 说明 |
| --- | --- |
| GM API 兼容层 | 统一 `GM_setValue` / `GM_xmlhttpRequest` / `GM_registerMenuCommand` 等大小写两种命名，缺失时自动降级（内存存储 / 页面 fetch），保证在任何管理器下都能跑 |
| M3 悬浮面板 | 可拖拽、可折叠、位置记忆、防飞出屏幕；圆角/阴影/配色全部走 Material Design 3 令牌 |
| 模式切换 | M3 Segmented Button（自动 / 手动），选中项白底浮起 |
| 进度条 | `setProgress(done, total, sub)` 一行调用 |
| 设置区 | Outlined Text Field 风格，含保存与恢复默认，值持久化到 GM 存储 |
| Toast 提示 | Snackbar 风格，四种语义色（info / success / warn / error），后台标签页自动跳过 |
| 运行日志窗 | 左下角，持久留存最近 50 条，带时间戳，可折叠可清空 |
| 调试入口 | 面板挂载后可通过 `__USERSCRIPT_TEMPLATE__` 在控制台读取设置与日志 |

设计令牌参考仓库根目录 [`Material-Design-Constitution/m3-web-vanilla`](../Material-Design-Constitution/m3-web-vanilla/)。

## 快速开始

1. 复制整个目录，重命名为你的脚本英文名（驼峰或短横线）。
2. 重命名 `.user.js` 主文件。
3. 修改文件顶部的元数据：

```js
// @name        你的脚本名
// @version     1.0.0
// @description 你的描述
// @author      LumiCornX
// @match       *://你的站点/*
```

4. 同步修改脚本内的常量：

```js
const SCRIPT_VERSION = '1.0.0';   // 必须与 @version 一致
const APP_NAME   = '你的脚本名';
const APP_ICON   = '🎯';
const PREFIX     = 'xx';          // 注入的 id/class 前缀，避免与宿主页面冲突
```

5. 在 `DEFAULTS` 里定义你的配置项，设置区会自动渲染并按名称映射到输入框。
6. 在业务钩子里写逻辑（文件第 8 节）：

```js
function onToggle(enabled) { enabled ? startWork() : stopWork(); }
function startWork() { /* 定时器 / 观察者 / 主循环 */ }
function stopWork()  { /* 清理所有定时器 */ }
function tick()      { /* 每一轮要干的事 */ }
```

7. 在根目录 `README.md` 的「脚本列表」表格里加一行。

## 约定

- **所有注入 DOM 的 class / id 必须带 `PREFIX` 前缀**，防止污染页面样式或被页面样式污染。
- **所有定时器必须有退出条件**（次数上限或超时），并在 `stopWork()` 里清理。
- **`SCRIPT_VERSION` 与 `@version` 必须同步修改**。
- 修改后用 `node --check 文件名.user.js` 做语法校验。
- 长流程要配防重入锁，参考智慧树脚本的做法。

## 目录结构

```
Userscript-Template/
├── userscript-template.user.js   # 主脚本（唯一需要安装的文件）
└── README.md                     # 本文件
```

## 许可

MIT
