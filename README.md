# 日历清单 · DeepSeek Harness 插件

在 [DeepSeek Harness](https://github.com/deepseek-ai) 左侧栏加一个**日历清单**入口，
主区是一个完整的个人任务管理器：月 / 周 / 列表 / 看板四种视图，右侧还带一条独立 AI 对话。

界面参考 macOS 日历与滴答清单。

![周视图](docs/preview-week.png)

<details>
<summary>更多截图</summary>

**月视图** — 农历、节气、传统节日

![月视图](docs/preview-month.png)

**列表视图** — 左侧清单导航、中间任务、右侧详情

![列表视图](docs/preview-list.png)

**任务详情** — 标题、日期、时间段、备注

![任务详情](docs/preview-task-detail.png)

</details>

## 功能

### 四种视图

| 视图 | 特点 |
|---|---|
| **周** | 0:00–24:00 时间轴，每小时 56px，视口约 13 小时，其余滚动；拖选空白创建任务；拖动事件改时间/日期 |
| **月** | 农历、节气、传统节日；周数栏；每天显示任务条 |
| **列表** | 三列结构（清单导航 / 任务列表 / 详情），按状态分组 |
| **看板** | 自定义分组列，拖动卡片切换分组 |

### 任务

- 点任务打开**右侧详情编辑**：标题、完成、日期、开始/结束时间、备注（任意长文本）、清单、删除
- 输入即保存（防抖），失焦后才重绘，打字不闪
- 优先级（普通 / 高）
- 深链 `?task=<id>` 直接打开某条任务

### 清单

- 默认四个：工作 / 生活 / 学习 / 收集箱
- **可增删改**：`+` 新建、双击改名、右键删除（删除时任务自动转移到第一个清单）
- 每个清单有独立颜色

### AI 对话

右侧是一条独立的 DSH 会话，用 `sessions` 服务创建并持久化。
中间的拖动分隔条可调整宽度，双击恢复默认。

## 安装

需要先装好 DeepSeek Harness（DSH）。

```bash
git clone https://github.com/yzsuki-afk/ticklist-calendar.git
```

然后在 DSH 里对 Agent 说：

> 帮我安装 `/你克隆到的路径/ticklist-calendar` 这个插件

Agent 会调用 `install_bundle` 完成安装，左侧栏随即出现「日历清单」。

> 插件通过绝对路径安装，不需要发布到 npm。

## 数据存哪

```
~/.dsh/storages/ticklist-calendar/tasks.json
```

一份 JSON，包含 `lists`（清单）、`groups`（看板分组）、`tasks`（任务）三段。
写入用「临时文件 + 原子重命名」，避免写一半断电损坏。
文件损坏时会自动备份成 `tasks.json.corrupt-<时间戳>` 再重置，不会静默吞掉数据。

想备份或迁移，直接复制这个文件即可。

## 技术实现

```
ticklist-calendar/
├── package.json          # bundle 清单 + dsh.client 声明
├── cordis.patch.yml      # 插入一行插件
├── index.js              # Host：页面路由 + GET/PUT /api/state + JSON 文件存储
├── client.js             # Client：左侧栏入口 + 主区（iframe + AI 对话 + 分隔条）
├── app/index.html        # 全部 UI（单文件 HTML/CSS/JS，无构建步骤）
├── locale/{zh,en}.json
├── icon.svg
└── docs/                 # 截图
```

几个值得记的点：

- **UI 是单个 HTML 文件**，没有打包步骤，改完刷新即生效；Host 只负责静态托管和数据接口。
- **右侧 AI 对话**借助会话作用域的子槽位拿到 `SessionProvider`，再用
  `renderFactorySlot('conversation.content', …)` 渲染原生对话界面。
- **时间轴用固定小时高度**而不是百分比铺满：窗口拉伸时事件块尺寸稳定，
  且不需要监听 resize 重排。
- **窗口拖拽的坑**：`-webkit-app-region: drag` 只在顶层文档生效，
  iframe 内部的元素拖不动窗口。所以顶栏由宿主侧 `client.js` 用 React 渲染，
  iframe 只承载内容区。

## 已知限制

- 只做了个人使用的核心功能：没有提醒通知、重复任务、标签、子任务、附件
- 清单/分组没有排序拖拽
- 数据是单机 JSON 文件，没有多端同步

## 许可

[MIT](LICENSE)
