# Luban Chat（Orca 本地插件）

[![License](https://img.shields.io/badge/License-Apache--2.0-blue)](LICENSE)

Orca 右侧栏的一个面板，把 Luban 当**原生聊天**用：正文、思考、工具行都是 Orca 自己的组件，
每次写文件走面板内的 diff 权限卡片。底下是一个 ACP 子进程（`luban-acp`），协议与
[Zed / JetBrains 那条路](https://github.com/eppen/luban/blob/main/docs/acp.md) 完全同一份，
不经过终端、也不占用任何内置 agent 槽位。

这个仓库是 Luban 的配套插件（独立发版，manifest id `luban-chat`）。Luban 本体（CLI / VS Code 扩展 /
`luban-acp`）在 [eppen/luban](https://github.com/eppen/luban)；Orca 的三条接入路线与全部踩坑记录在
[docs/orca.md](https://github.com/eppen/luban/blob/main/docs/orca.md)。

## 安装

```bash
orca plugin install eppen/luban-orca-plugin
```

Orca 会取**最新的 `vX.Y.Z` tag**（没有 tag 才退回默认分支），并固定到具体 commit。
插件带 `execution: trusted-worker`（要起子进程），所以第一次会以 `approval_required` 退出，
按提示带上 `--approve <fingerprint>` 重跑即可：

```bash
orca plugin install eppen/luban-orca-plugin --approve ap1-…
orca plugin open local.luban-chat
```

想装某个具体版本就加 `@v0.1.0`；从本地目录装用 `orca plugin install ./`。

## 为什么不用「借槽位」

[Orca 文档](https://github.com/eppen/luban/blob/main/docs/orca.md) 里的路线一是把某个内置槽位
（如 Charm Crush）的 Command 改成 `luban`，只能
**在终端里**跑 REPL。想换成 Orca 的 chat surface 会被直接拒：

```
agent_launch_surface_unavailable
"crush can't open as a chat here because this agent has no structured session."
```

因为 Orca 的结构化聊天只认它编译期内置的那几条 launch spec。插件是另一条通道：面板自带 UI、
worker 自带进程，ACP 消息由我们自己翻成 Orca 的组件。代价是这个文件夹得装在 Orca 上。

## 文件分工

| 文件 | 作用 |
|---|---|
| `orca-plugin.json` | manifest：id `luban-chat`、面板入口、三项设置、`trusted-worker` 执行模型、`workspace:read` + `settings:own` 两个能力 |
| `src/worker.ts` | 插件 worker：持有 `luban-acp` 子进程，把 ACP update 折成 `ChatState`，回答面板的请求 |
| `src/acp.ts` | 极薄 ACP 客户端（stdio 上的 newline-delimited JSON-RPC 2.0）：`initialize` / `session/new` / `session/prompt` / `session/cancel`，加上 `session/request_permission` 的回包 |
| `src/panel.tsx` | 面板 UI：消息流、工具行、权限卡片（带 diff）、输入框、取消 / 重置 |
| `src/protocol.ts` | 面板 ↔ worker 的唯一契约（两边都从这里 import 类型） |
| `src/*.test.ts(x)`、`src/panel.check.ts` | `orca plugin test` 跑的单测；`orca plugin check` 渲染面板用的场景 |

**没有构建步骤**：Orca 加载时自己把 `.ts` / `.tsx` 转译掉，改完保存即热重载。
`npx tsc -p .` 只做类型检查，用的 typings 由 `orca plugin types .` 写进 `.orca/types/`（该目录不入库）。

## 开发

```bash
git clone git@github.com:eppen/luban-orca-plugin.git
cd luban-orca-plugin
orca plugin validate .              # manifest + 文件清单 + 能力声明
orca plugin dev load .              # 作为开发插件加载（要代码执行能力，首次给 --approve <fingerprint>）
orca plugin open local.luban-chat   # 在右侧栏打开面板
orca plugin dev watch .             # 边改边看日志和重载，Ctrl-C 卸载
```

卸载：`orca plugin uninstall local.luban-chat`。本仓库之外没有别的安装形态 —— 不进 Orca 的
catalog，也不发 npm 包（`package.json` 里的依赖只为 `tsc` 类型检查，`private: true`）。

想用**仓库版本**的 Luban（而不是全局 npm 装的旧版）就把设置 `acpCommand` 写成
`node /path/to/luban/dist/acp.js`，见下文「三项设置」。

## 发版

Orca 按 `vX.Y.Z` tag 取版本，所以一次发版是三处同步 + 一个 tag：

```bash
# 1. orca-plugin.json 的 version 与 package.json 的 version 改成同一个值
git commit -am 'release v0.1.1' && git tag v0.1.1
git push origin main --tags
```

改完代码后如果 worker 行为没变，先 `orca plugin restart local.luban-chat` —— worker 热重载会丢掉
当前会话（进程归 worker 所有，这是有意的）。

## 三项设置

在 **Settings → Plugins → Luban Chat** 里填（`orca-plugin.json` 的 `contributes.settings`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `acpCommand` | 空 | 启动 ACP server 的命令行。空 = 先找 `~/.local/bin/luban-acp`，再落到 PATH 上的 `luban-acp`。**要用仓库版本就填绝对路径**，如 `node /path/to/luban/dist/acp.js` |
| `model` | 空 | 作为 `--model` 传给 ACP 进程（`luban --list-models` 的 key）。空 = 用 `~/.luban/config` 里的默认 |
| `readOnly` | false | 加 `--read-only`：写工具与写命令都被拒（Plan 那种只读档） |

> 注意版本落差：本机 `/opt/homebrew/bin/luban-acp` 与 `~/.local/bin/luban-acp` 都可能指向**全局 npm 安装**的旧版
> （实测是 1.102.0），而仓库是 1.137.x。想用仓库版本就在 `acpCommand` 里写死 `node <repo>/dist/acp.js`，
> 否则面板里看到的版本、能力（比如新工具）会跟仓库对不上。

worker 会用 `--root <工作区路径>` 启动进程，路径由 `workspace.readContext` 与 `workspace.list` 决定，
取**当前焦点工作区**；都读不到才退回 worker 自己的 cwd。

## 面板 ↔ worker 协议

面板只用 `plugin.request` 问，worker 用 `orca.panels.handle` 答，任何变化再 `orca.panels.post` 广播。
全部名字与载荷都在 `src/protocol.ts`：

| 名字 | 方向 | 载荷 |
|---|---|---|
| `chat.state` | 请求 | 无入参，返回整个 `ChatState`（面板重开时靠它重绘） |
| `chat.send` | 请求 | `{ text }` → `{ ok, error? }`；只表示**已排队**，回复靠流式 update |
| `chat.permission` | 请求 | `{ id, choice }` → `{ ok }`，`choice` 取权限卡片里的 `optionId` |
| `chat.cancel` | 请求 | 取消当前轮（顺手把挂着的权限请求答成拒绝） |
| `chat.reset` | 请求 | 丢掉进程与会话，下一句重新 `session/new` |
| `chat.state.changed` | 事件 | 广播整份 `ChatState` 给每个打开的面板 |

`ChatState.status` 五态：`idle`（空闲）/ `starting`（启动中）/ `working`（干活中）/
`waiting`（等你确认）/ `error`（出错）。同一时刻只允许一轮：`working` / `waiting` / `starting`
期间再发会被拒（"上一轮还在跑"）。

## 权限卡片

ACP 那边是 `session/request_permission`，三个选项原样搬进面板（`acp.js` 里定义）：

| `optionId` | 面板文案 | 效果 |
|---|---|---|
| `allow_once` | 允许这次写入 | 只放行这一次 |
| `allow_always` | 本会话内允许全部写入 | 本会话后续写不再问 |
| `reject_once` | 拒绝 | 工具被拒，agent 收到后自己找别的路或停下 |

卡片带一个极简 unified diff（`-旧` / `+新` 全量对照，不做 hunk 折叠），路径取第一个被写的文件。

## 测试

```bash
orca plugin test .      # 7 个用例：面板重绘 / 权限卡片 / 空消息拒绝 / reset
orca plugin check .     # 用 worker 渲染一次面板，肉眼过一遍布局

npm install             # 只为类型检查装 typescript 与 @types/node（Orca 加载时用不到）
npm run check           # tsc -p . 对着 .orca/types 检查（先 orca plugin types . 生成 typings）
```

端到端（不点界面）走 worker 的 bridge，和面板发请求是同一条路：

```bash
orca plugin dev request . chat.send   --data '{"text":"只回复两个字：收到"}'
orca plugin dev request . chat.state  | jq '.result.result.status'
orca plugin dev request . chat.permission --data '{"id":"perm_1","choice":"allow_once"}'
```
