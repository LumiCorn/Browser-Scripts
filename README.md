# Browser-Scripts

自制浏览器脚本合集，适配 ScriptCat（脚本猫）/ Tampermonkey（油猴）。每个脚本一个子目录，各自带独立 README 和技术文档。

## 一键安装

先安装脚本管理器：[ScriptCat](https://docs.scriptcat.org/) 或 [Tampermonkey](https://www.tampermonkey.net/)，然后点击下面的链接即可安装（浏览器会自动弹出安装界面）：

| 脚本 | 一键安装 |
| --- | --- |
| 智慧树问答自动化 v3.4.0 | [📥 安装](https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-WenDa-Autoscript/zhihuishu-qa-automation.user.js) |
| 智慧树标题状态 v1.3.0 | [📥 安装](https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/ZhiHuiShu-Title-Status/zhihuishu-title-status.user.js) |
| UserScript 模板 v1.1.0 | [📥 安装](https://cdn.jsdelivr.net/gh/LumiCorn/Browser-Scripts@main/Userscript-Template/userscript-template.user.js) |

> 安装链接走 [jsDelivr](https://www.jsdelivr.com/) CDN 镜像，国内可直接访问。
> 若链接无法安装，用下面的 raw 地址，或直接把 `.user.js` 文件内容粘贴进管理器。

<details>
<summary>raw.githubusercontent.com 直链（国内可能访问不稳定）</summary>

- [智慧树问答自动化](https://raw.githubusercontent.com/LumiCorn/Browser-Scripts/main/ZhiHuiShu-WenDa-Autoscript/zhihuishu-qa-automation.user.js)
- [智慧树标题状态](https://raw.githubusercontent.com/LumiCorn/Browser-Scripts/main/ZhiHuiShu-Title-Status/zhihuishu-title-status.user.js)
- [UserScript 模板](https://raw.githubusercontent.com/LumiCorn/Browser-Scripts/main/Userscript-Template/userscript-template.user.js)

</details>

## 脚本列表

| 脚本 | 说明 | 平台 |
| --- | --- | --- |
| [ZhiHuiShu-WenDa-Autoscript](ZhiHuiShu-WenDa-Autoscript/) | 智慧树（知到）问答互动分全自动脚本：AI 自动回答 + 自动提问，M3 悬浮面板，父子页面架构，子页面回传官方数据 + 双保险停止（v3.4.0） | ScriptCat / Tampermonkey |
| [Userscript-Template](Userscript-Template/) | 脚本通用模板：M3 悬浮面板 + Toast + 运行日志 + 设置读写 + GM API 兼容层，复制即可开新脚本（v1.1.0） | ScriptCat / Tampermonkey |
| [ZhiHuiShu-Title-Status](ZhiHuiShu-Title-Status/) | 智慧树标签页标题状态显示：把标题改成「状态 - 用户名」如「首页 - 李侠」，纯执行无 UI（v1.3.0） | ScriptCat / Tampermonkey |

## 设计规范参考（共用）

[Material-Design-Constitution](Material-Design-Constitution/) 收录 Material Design 3 全套设计规范，已从 ZhiHuiShu-WenDa-Autoscript 抽出至根目录，供所有子项目直接引用：

| 目录 | 内容 |
| --- | --- |
| [m3-web-vanilla](Material-Design-Constitution/m3-web-vanilla/) | 纯 CSS 自定义属性实现 M3（含 `m3-tokens.css` 设计令牌），零依赖 |
| [material-design-3-color](Material-Design-Constitution/material-design-3-color/) | M3 Expressive 动态颜色与主题规范（配色 / 主题 / 无障碍） |
| [material-design-3-components](Material-Design-Constitution/material-design-3-components/) | M3 组件大全（按钮、导航、容器、输入等，含状态与实现规范） |

## 新增脚本的规范

1. 在根目录新建子文件夹，文件夹名 = 脚本英文名（驼峰或短横线）。
2. 子文件夹内放 `.user.js` 主文件 + 可选 `README.md` / `docs/`。
3. 在上方「脚本列表」表格里加一行。

## 安全约定

- **任何脚本都不得内置 API Key、Cookie、Token 等凭据。** 需要凭据的功能一律做成脚本面板里的用户自填项，存储在浏览器本地（`GM_setValue`）。
- `.gitignore` 已排除 `.env*`、`*.storage.json`、`*.options.json`、`scriptcat-backup*.zip` 等本地产物。
- 提交前请自查：`git diff --cached | Select-String "sk-[A-Za-z0-9]{20,}"`。

