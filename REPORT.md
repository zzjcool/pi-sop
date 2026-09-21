# pi-sop 核心实现 —— 完成报告

分支：`pi-subagent/worker-0-eea7f442`（已推送）
提交：`1d9024a feat: implement pi-sop core extension`
工作区：`/root/code/pi-sop/.pi-subagents/runs/r-ec4987a4/worktrees/worker-0`

---

## 1. 改动文件清单

### 新增（源码，按设计文档 §8 拆分）

| 文件 | 对应设计章节 | 说明 |
|---|---|---|
| `src/lib/config.ts` | §1.1 / §1.2 | `~/.pi/agent/pi-sop.json` 原子读写；三级路径解析（`PI_SOP_DIR` > `config.libDir` > `~/sop-library`）；配置只写 agent 目录，**绝不写进库仓库** |
| `src/lib/probe.ts` | §1.3 | `probeLibrary()` 六态状态机；纯 `fs` + 自写 git-config 解析器，session_start 路径**零 spawn、零网络** |
| `src/lib/sop.ts` | §6 | frontmatter 解析（与 pi 自带 parser 行为对齐：BOM / CRLF / `---` 边界）、slug 规则、MANIFEST 渲染 |
| `src/lib/scaffold.ts` | §6 | 库骨架（`git init -b main`、`MANIFEST.md`、`sop/writing-sops.md` 种子 SOP、`.gitignore`）+ `refreshManifest()`；**纯增量，绝不覆盖已有文件** |
| `src/lib/sync.ts` | §5 | flock 互斥、`pull --rebase --autostash` / `push`、超时、10min 进程内节流、**绝不 force / 绝不 reset** |
| `src/lib/remote.ts` | §3.2 分支 1 | `git ls-remote` 预检 + 把 git stderr 翻译成「SSH key / https 凭证 / 仓库不存在」三类可操作提示 |
| `src/commands/init.ts` | §3 | `/sop init` 完整向导（主菜单四选一、克隆/新建/关联/禁用、gh CLI 检测、状态面板、`await ctx.reload()`）+ §3.5 无交互参数 |
| `src/index.ts` | §2 | 接线：`session_start` 探测+单次 notify、`resources_discover` 注册 `<libDir>/sop`、`sop_save` 工具（含 autoInit 静默降级）、`/sop` 命令（init/status/sync/检索） |

### 新增（工程配置 / 测试）

| 文件 | 说明 |
|---|---|
| `tsconfig.json` | strict + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters` |
| `package.json`（改） | 加 `dependencies.typebox`、`devDependencies`（typescript/tsx/@types/node/pi-coding-agent）、`typecheck`/`test`/`verify` 脚本 |
| `package-lock.json` | 依赖锁定 |
| `test/helpers.ts` | 隔离 sandbox（每个用例独立 `HOME` + `PI_CODING_AGENT_DIR`，**不碰真实 `~/.pi/agent/pi-sop.json`**） |
| `test/config.test.ts` | 12 例：三级路径优先级、配置损坏降级、原子写 |
| `test/probe.test.ts` | 18 例：六态各一 + worktree `.git` 文件 / 相对 gitdir / 引号值 |
| `test/scaffold.test.ts` | 16 例：骨架、种子 SOP 合法性、MANIFEST 四列、增量性、重建 |
| `test/sop.test.ts` | 21 例：frontmatter/BOM/CRLF/列表归一化、slug、MANIFEST 转义 |
| `test/sync.test.ts` | 24 例：锁、超时配置、真实远端 push/pull、冲突保留、节流 |
| `test/init.test.ts` | 15 例：参数解析 + 非覆盖守卫 |
| `test/index.test.ts` | 19 例：**端到端接线**（真实 `pi` API 形状的假 API）+ 双机同步 |
| `README.md`（改） | 仅勾选 Status 复选框；**未改设计原则部分** |

---

## 2. 验证输出（原样）

### `npm run typecheck`

```
$ npm run typecheck
> pi-sop@0.1.0 typecheck
> tsc --noEmit
```
（无输出 = 通过，exit 0）

### `npm test`

```
1..125
# tests 125
# suites 0
# pass 125
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10445.426319
```

### 真实 pi 端到端（RPC 模式，非 mock）

```
$ pi --mode rpc -e ./src/index.ts   # PI_SOP_DIR=/tmp/live/soplib

=== get_commands（/sop 是否注册）:
 [{"name":"sop","description":"SOP library: init wizard, status, sync, or search the library",
   "source":"extension","sourceInfo":{"path":".../src/index.ts","scope":"temporary"}}]

=== 执行 /sop init --local:
已创建本地 SOP 库：/tmp/live/soplib。运行 /sop init 可随时补充远端实现多机同步。
SOP 库就绪：/tmp/live/soplib（1 个 SOP，远端: 本地模式）
```

### 真实 pi 端到端 —— reload 后 SOP 变成 skill（本次最关键验证）

```
BEFORE init — skill commands: []
AFTER  init — skill commands: ["skill:agent-browser","skill:find-skills","skill:writing-sops"]
writing-sops discovered? YES

ALL NOTIFIES:
pi-sop: SOP 库未初始化，运行 /sop init 开始          ← 每进程仅一次
已创建本地 SOP 库：/tmp/live/soplib。运行 /sop init 可随时补充远端实现多机同步。
SOP 库就绪：/tmp/live/soplib（1 个 SOP，远端: 本地模式）
```

---

## 3. 设计文档 §6「待验证技术风险点」—— 已实测，无需回退方案

任务书给出的已验证事实在真实代码路径上复核成立：

- `loadSkills({ skillPaths: ["<libDir>/sop"] })` 能识别该目录下**所有**带 `description` 的平铺 `.md`（`sop/<name>.md` 布局成立，**不需要** `SKILL.md` 目录布局）。
- 无 frontmatter / 无 `description` 的文件被静默忽略（不会产生噪音诊断）。
- 库根目录的 `MANIFEST.md` 不在注册路径内，不会混进 skill 列表。
- 端到端确认：`/sop init --local` 后 `get_commands` 立刻出现 `skill:writing-sops`，证明 `ctx.reload()` + `resources_discover` 的时序正确。

回归保护：`test/index.test.ts` 的 *"the registered skillPath actually yields skills via pi's loader"* 与 *"two-machine flow"* 两个用例直接调用 pi 的公开 `loadSkills`，一旦上游收紧该规则就会失败。

---

## 4. 实现中发现并修复的真实缺陷（实现期偏离记录）

这些是**实现过程中由测试抓出、已修复**的问题，不是对计划的偏离：

1. **`git pull/push` 收到 `probe.gitDir`（`.../.git`）导致必然失败** — 原设计把 `probeLibrary().gitDir` 传给同步函数，但 `git pull` 在 `cwd` 位于 git dir 内部时报 `fatal: this operation must be run in a work tree`，即线上同步会**静默永不生效**。已把 `sync.ts` 的语义统一为「收工作树目录」，锁路径则从 git dir 推导（`lockPathForDir`），保证 linked worktree 共享同一把锁且锁文件永不落入工作树。
2. **`init.ts` 复制了一份路径解析且优先级写反** — 它把 `config.libDir` 放在 `PI_SOP_DIR` 之前，违反设计 §1.1 冻结顺序。已删除该重复实现，统一走 `resolveLibDir()`；`createFlow` 同样改为使用解析结果（此前恒用 `~/sop-library`，忽略 `PI_SOP_DIR`）。
3. **锁检测存在竞态与固定 250ms 延迟** — 改为 `flock -n <file> -c 'echo LOCKED; cat'`，靠 `LOCKED` 标记确定性判定，并在 `finally` 中 `await` 释放。`flock` 不可用时降级为进程内队列。

上述 1、2 属于「按设计文档字面实现会出错」的情况，均已修正；无其他偏离。

---

## 5. 与 README / 计划的其它出入

- **`docs/init-design.md` 未纳入本次提交**：该文件在仓库中处于 untracked 状态（`git ls-files` 不含它），不在本任务的实现范围内，故未修改、未提交。设计文档 §6 末尾的风险结论我写在了本报告第 3 节与测试注释中。
- README「Design rules」原则部分**未改动**，只勾选了 Status 的 Core extension 一项。
- `src/index.ts` 原 TODO 骨架已整体替换为实现；文件头注释保留并更新。

---

## 6. 未决问题 / 需人工介入

1. **MR 未能自动创建**：环境无 `gh` CLI、无 `GITHUB_TOKEN`、GitHub API 匿名配额已耗尽，无法以编程方式开 PR。分支已推送，可直接用以下链接开 PR：
   - 创建 PR：https://github.com/zzjcool/pi-sop/compare/main...pi-subagent/worker-0-eea7f442?expand=1
   - 分支：https://github.com/zzjcool/pi-sop/tree/pi-subagent/worker-0-eea7f442
   - 注意：远端目前**尚无 `main` 分支**（`git ls-remote origin` 只有本分支 + HEAD）。本地 `main` = `354b704`，是本分支的祖先，可安全作为 base。
2. **交互式向导未做键盘级手测**：`ctx.ui.select/confirm/input` 的分支逻辑已由参数解析 + 守卫函数单测覆盖（`test/init.test.ts`），但完整 TUI 走查（克隆失败重输、gh 建仓、状态面板四个动作）尚未在真实终端里点一遍。无交互分支（`--clone/--local/--link/--disable`）已在真实 pi RPC 下验证。
3. **`sop_save` 的 push 行为未在真实带远端环境验证**：单测用 `file://` bare 远端覆盖了 push 成功/失败/冲突三条路径；真实 GitHub 推送需凭据，属未测边界。
4. `flock` 为 Linux/macOS 依赖；非 POSIX 平台降级为进程内队列（已在 `sync.ts` 中实现并注明），跨进程互斥保证随之减弱。

---

## 7. 验收对照

| 任务要求 | 状态 |
|---|---|
| 文件放 `src/` 下，入口 `src/index.ts` | ✅ |
| `npx tsc --noEmit` 通过 | ✅ strict，exit 0 |
| config/probe/scaffold 最小单测，`node:test`，不引重框架 | ✅ 46 例（config 12 / probe 18 / scaffold 16），共 125 例全部通过 |
| SOP frontmatter 按 §6 | ✅ 含 `name`/`description`/`triggers`/`last_verified` |
| MANIFEST 为 `name\|description\|triggers\|last_verified` 表格 | ✅ 管道转义、确定性排序 |
| `session_start` 不阻塞、不弹窗、每进程一次 notify | ✅ 由拒绝一切 prompt 的 ctx 在测试中断言 |
| 绝不 force-push | ✅ 源码级断言（`sync.test.ts` 扫描 push argv 不含 `--force`/`+refspec`） |
| 不强推 main、不在本地 merge | ✅ 仅推送特性分支 |
| 遵守安全规则（不写 .env/.git/node_modules、不 sudo） | ✅ 测试沙箱隔离 `HOME`，不触碰真实 `~/.pi/agent` |
