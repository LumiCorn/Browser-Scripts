# Browser-Scripts

自制浏览器脚本合集。每个脚本一个子目录，各自带独立 README 和技术文档。

## 脚本列表

| 脚本 | 说明 | 平台 |
| --- | --- | --- |
| [ZhiHuiShu-WenDa-Autoscript](ZhiHuiShu-WenDa-Autoscript/) | 智慧树（知到）问答互动分全自动脚本：AI 自动回答 + 自动提问，M3 悬浮面板，父子页面架构（v2.9.0） | ScriptCat / Tampermonkey |

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
