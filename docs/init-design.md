# pi-sop 初始化设计（技术 + 交互细节）

> 状态：设计稿 v1，待评审后实现。
> 前置阅读：README.md（四大能力与冻结规则）、pi docs/extensions.md、pi docs/skills.md。

## 0. 驱动设计的硬约束

| 约束 | 来源 | 对设计的直接影响 |
|---|---|---|
| `session_start` 绝不阻塞 | README 冻结规则 | 初始化向导**不在** session_start 里跑，只做 fs 级探测（stat，无网络），未初始化时仅发一行 notify |
| `resources_discover` 只在 startup/reload 触发 | pi 生命周期 | 初始化完成后必须 reload 才能注册 skillPaths；向导末尾直接 `await ctx.reload()`（命令上下文可用） |
| 离线机器降级为只读本地缓存 | README | 所有 git 网络操作带超时（5~8s），失败只降级不报错 |
| 多 pi 进程并发操作同一库 | 多 pane/多机器场景 | `pull/commit/push` 全部包在 `flock` 互斥锁里 |
| 用户可能没建远端就想用 | 降低上手门槛 | 支持 local-only 模式：先本地 git，远端后补 |

## 1. 库路径解析与状态机

### 1.1 路径解析顺序（每次用到时现算，不缓存到内存）

```text
1. env PI_SOP_DIR          （显式覆盖，测试/多库场景）
2. ~/.pi/agent/pi-sop.json 的 libDir   （/sop init 写入的持久配置）
3. ~/sop-library           （约定默认路径，存在即用）
```

三者都无 → 状态 `missing`。

### 1.2 配置文件 `~/.pi/agent/pi-sop.json`

```json
{
  "version": 1,
  "enabled": true,
  "libDir": "/Users/zzjcool/sop-library",
  "autoInit": true,
  "initializedAt": "2026-09-21T07:00:00Z",
  "lastSyncAt": "2026-09-21T07:00:00Z"
}
```text

- `enabled: false`：`/sop init` 的"禁用"出口写入；扩展整体静默（不注册 skillPaths、`sop_save` 返回提示）。
- `autoInit`：见 §4，`sop_save` 在未初始化时是否自动创建 local-only 库，默认 `true`。
- 注意：写配置属于扩展自身状态，放 `~/.pi/agent/`，**不写** SOP 库仓库内部（库是跨机器共享的，机器私有配置不能进库）。

### 1.3 库状态机（探测函数 `probeLibrary()`，纯本地 fs + git config 读，无网络）

```
missing        路径不存在
empty-dir      目录存在但为空（用户手建了目录）
not-a-repo     有内容但不是 git 仓库
no-remote      是 git 仓库但 origin 未配置（local-only）
ready          git 仓库 + 结构合法（MANIFEST.md 存在 或 sop/ 目录存在）
malformed      是仓库但结构不对（无 MANIFEST 且无 sop/）
```text

`probeLibrary()` 在三处被调用：
- `session_start`：只读探测，决定 notify 文案与是否注册 skillPaths
- `/sop init` 向导第 0 步：决定向导分支
- `sop_save` / `/sop` 执行前：守门

## 2. 触发点设计（三个入口，一种状态）

### 2.1 `session_start`（被动，非阻塞）

```
reason ∈ {startup, reload, new, resume, fork} 都执行：
  state = probeLibrary()          // <5ms，纯 fs
  enabled=false 或 state=missing 且从未初始化过 → 完全静默？
    → 不静默：missing 且 config 文件不存在时，发一次 notify：
      "pi-sop: SOP 库未初始化，运行 /sop init 开始（详见 /sop help）"
      （每个进程只提示一次，用内存 flag；resume/fork 不重复刷屏）
  state=ready → 后台 best-effort 同步（见 §5），skillPaths 已由
      resources_discover 提供
```text

要点：**session_start 里永远不弹 select/confirm/input**。pi 的扩展可以弹，但对"每次启动都要跑"的钩子来说弹窗等于把初始化强塞给用户，违背 best-effort 原则。notify 是唯一出口。

### 2.2 `/sop init`（主动，交互式向导）—— 人类主路径

`ctx.mode === "tui"` 时走完整向导；print/rpc 模式下支持无交互参数形式（见 §3.5）。

### 2.3 `sop_save` 工具（被动，agent 触发）—— 降级路径，见 §4

## 3. `/sop init` 向导详细流程

### 3.1 第 0 步：现状探测与短路

```
state = probeLibrary()
config.enabled === false →
  confirm("pi-sop 已禁用", "重新启用？") → 是：改 enabled=true 继续；否：退出

state = ready 且 origin 存在 →
  直接进入"状态面板"（§3.4），不重复初始化
state = no-remote →
  状态面板 + 追加一项"配置远端以启用多机同步"
其余 → 进入第 1 步主菜单
```text

### 3.2 第 1 步：主菜单（`ctx.ui.select`）

```
SOP 库初始化（当前: ~/sop-library 不存在）

  1. 克隆已有的 SOP 库          （多机场景：在 GitHub/GitLab 上已有仓库）
  2. 全新创建一个 SOP 库        （第一台机器：从零开始）
  3. 关联本机已有目录            （手动 git clone 过了，或想自定义路径）
  4. 暂不使用 pi-sop            （禁用，扩展静默）
```text

#### 分支 1：克隆已有库

```
input("远端地址", placeholder "git@github.com:you/sop-library.git")
  → 预检：git ls-remote <url>（timeout 5s）
      失败 → 显示 stderr 首行 + 常见原因提示
        （SSH key 未配置 / https 需要凭证 / 仓库不存在）
        → 选项：重输地址 / 改用 https / 返回主菜单
  → git clone <url> <libDir>（timeout 30s，库预期 <几MB）
  → 结构校验：MANIFEST.md 或 sop/ 存在？
      不存在 → confirm("仓库结构不像 SOP 库", "补齐缺失的骨架文件？")
        是 → scaffold（只补缺，不覆盖已有文件）
  → 写配置 → 完成
```text

细节：
- 克隆目标路径冲突（目录已存在非空）→ 直接报错返回重输，不覆盖任何已有文件。
- `--depth` 不用：库小，且后续要 push/rebase，浅克隆添乱。

#### 分支 2：全新创建

```
select("库位置")：
  a. 默认 ~/sop-library
  b. 自定义路径 → input("绝对路径", 默认 ~/sop-library)
     （校验：父目录存在、目标不存在或为空）

scaffold(libDir)：
  git init -b main
  写入骨架（见 §6）
  git add -A && git commit -m "init: scaffold SOP library"

远端配置（可选）：
  检测 gh CLI 是否可用 →
    可用：confirm("检测到 GitHub CLI", "用 gh 创建私有远端仓库并推送？")
      是 → gh repo create sop-library --private --source . --push
           （失败 → 降级为手动输入远端）
  不可用或上一步选否：
    input("远端地址（留空 = 先只用本地，之后 /sop init 可补）")
      非空 → git remote add origin <url> && git push -u origin main
             （push 失败 → 保留本地库，notify 提示原因，不算初始化失败）
  留空 → local-only 模式完成，notify：
    "已创建本地 SOP 库：<libDir>。之后随时运行 /sop init 补充远端实现多机同步。"
```text

#### 分支 3：关联已有目录

```
input("库路径", 默认 ~/sop-library)
  → probeLibrary(path)：
    ready        → 直接采纳，写配置
    not-a-repo   → confirm("该目录不是 git 仓库", "初始化为 git 仓库？")
                    是 → git init -b main && scaffold 缺失部分 && 首次 commit
    malformed    → confirm("缺少 SOP 库结构", "补齐骨架？") → scaffold
    empty-dir    → 同分支 2 的 scaffold 流程（跳过位置选择）
```text

#### 分支 4：禁用

```
写 config { enabled: false } → notify("pi-sop 已禁用，/sop init 可重新启用")
```text

### 3.3 完成步骤（所有成功分支汇合）

```
1. 首次同步：git pull --rebase（有远端才做，timeout 8s，失败仅警告）
2. 写 ~/.pi/agent/pi-sop.json
3. notify("SOP 库就绪：<libDir>（N 个 SOP，远端: xxx/无）")
4. await ctx.reload()   // 关键：让 resources_discover 重新跑，skillPaths 立即生效
   （reload 后本 handler 旧帧即终结，return 即可）
```text

### 3.4 状态面板（`ready` 时 `/sop init` 直接进入）

```
SOP 库状态
  路径:     /Users/zzjcool/sop-library
  远端:     git@github.com:you/sop-library.git (main)
  SOP 数量: 12
  待推送:   2 个本地提交
  最近验证: deploy-mysql-replica (2026-09-01, 20 天前)

  [立即同步] [配置远端] [重建 MANIFEST] [退出]
```text

"重建 MANIFEST"：扫描 `sop/*.md` 的 frontmatter 重新生成索引（MANIFEST 漂移时的修复工具）。

### 3.5 非交互模式（print/rpc，或脚本化）

```
/sop init                      # TUI 下进向导；非 TUI 下打印状态 + 提示需参数
/sop init --clone <url>        # 无交互克隆
/sop init --local [path]       # 无交互新建 local-only 库
/sop init --link <path>        # 无交互关联已有目录
/sop init --disable
```text

无交互分支中任何需要决策的异常（如目录冲突）直接失败并输出原因，不猜。

## 4. `sop_save` 的降级路径（agent 触发时未初始化）

原则：**知识捕获不被初始化状态卡死**。

```
sop_save 执行时 probeLibrary()：
  ready / no-remote → 正常写
  enabled=false     → 返回文本："pi-sop 已被用户禁用，请告知用户运行 /sop init 重新启用"
  missing/empty-dir 且 config.autoInit=true →
    静默 scaffold local-only 库（无远端、无交互——工具里不弹任何 UI），
    正常写入 + 本地 commit（不 push），结果文本附带：
    "已自动创建本地 SOP 库 <libDir>（local-only）。
     提醒用户运行 /sop init 配置远端可实现多机同步。"
  autoInit=false   → 返回："SOP 库未初始化。请让用户运行 /sop init，或将 PI_SOP_DIR 指向已有库。"
```text

理由：`sop_save` 常发生在任务收尾时，此刻打断用户做向导体验最差；local-only 自动建库是可逆、无副作用的（就一个本地目录 + 本地 commit），把"连远端"这个不可逆决策留给人类。

注意：自动 scaffold 后本会话的 skillPaths 不会自动刷新（resources_discover 已跑过），下次启动/reload 自然生效 —— 可接受，不为此单独 reload。

## 5. 同步细节（session_start 与状态面板共用）

```
syncLibrary():
  state != ready-ish → skip
  进程内节流：距上次同步 <10min → skip（防 /resume /fork 重复拉）
  flock <libDir>/.git/pi-sop.lock（非阻塞抢锁，抢不到 → 别的进程在同步，skip）
  git pull --rebase --autostash（timeout 8s）
    成功 → 更新 config.lastSyncAt
    冲突 → notify("pi-sop: 同步冲突，已保留本地，运行 /sop init 查看")
           终不 force / 不 reset，冲突留给状态面板的人工出口
    超时/网络失败 → 静默降级（本地缓存照常服务 skill），仅 debug 日志
```text

push（sop_save 内）：commit 总是先落本地；push 失败 → 结果文本带警告"已本地提交，推送失败：<原因>，下次会话重试"。**绝不 force-push**（冻结规则）。

## 6. 库骨架（scaffold 内容）

```
<libDir>/
├── MANIFEST.md          # 索引：表格 name | description | triggers | last_verified
│                        #   由 sop_save 维护，/sop init 可重建
├── sop/
│   └── writing-sops.md  # 种子 SOP（带合法 frontmatter），本身就是"如何写 SOP"的
│                        #   技能说明 —— agent 首次就有了可参照的格式范例
└── .gitignore           # .DS_Store / *.swp / .pi-sop-lock
```text

种子 SOP `writing-sops.md` 的 frontmatter：

```yaml
---
name: writing-sops
description: USE FOR creating or updating SOPs in the pi-sop library — format, frontmatter, MANIFEST conventions
triggers: save sop, 记录流程, write sop
last_verified: <scaffold 当天>
---
```

### ⚠️ 待实现时验证的技术风险点

skill 布局：README 设计是 `sop/<name>.md` 平铺，靠 skillPaths 的"根 .md + 合法 frontmatter 即被发现"规则。pi 文档明确写了这条规则适用于 `~/.pi/agent/skills/` 和 `.pi/skills/`，**对 `resources_discover` 返回的自定义路径是否同样宽松需要实测**（dynamic-resources 示例只演示了直接指向一个 SKILL.md 文件）。验证方案：

```text
建临时目录放两个带 frontmatter 的 .md → resources_discover 返回该目录 →
pi 启动看是否都被识别为 skill
```

若平铺 .md 不被发现 → 回退方案：`sop_save` 改写为 `sop/<name>/SKILL.md` 目录布局（对外 URL/引用不变，MANIFEST 照常索引），README 同步更新。

## 7. 交互文案汇总（一次性定稿，实现直接抄）

| 场景 | 文案 |
|---|---|
| 启动时未初始化（每进程一次） | `pi-sop: SOP 库未初始化，运行 /sop init 开始` |
| 初始化成功 | `SOP 库就绪：<path>（N 个 SOP，远端: <remote|本地模式>）` |
| local-only 建库 | `已创建本地 SOP 库：<path>。运行 /sop init 可随时补充远端实现多机同步。` |
| 同步冲突 | `pi-sop: 同步冲突，本地修改已保留。运行 /sop init → 状态面板处理` |
| sop_save 推送失败 | `已本地提交；推送失败（<原因>），将在下次会话重试` |
| 禁用后 sop_save | `pi-sop 已禁用，请用户运行 /sop init 重新启用` |

## 8. 实现拆分建议（后续任务）

1. `src/lib/config.ts` —— 配置读写 + 路径解析（无依赖，先行）
2. `src/lib/probe.ts` —— probeLibrary 状态机（纯函数，易测试）
3. `src/lib/scaffold.ts` —— 库骨架 + 种子 SOP
4. `src/lib/sync.ts` —— flock + pull/push（超时、降级、节流）
5. `src/commands/init.ts` —— 向导（依赖 1-3）
6. `src/index.ts` —— session_start 探测 + resources_discover + sop_save 接线
7. 风险点验证（§6 末尾）插在 5 之前做，决定 `sop_save` 的文件布局

配套：tsconfig + `tsc --noEmit` typecheck、极小单元测试（probe/scaffold），向导用 `-e` 手测清单。
