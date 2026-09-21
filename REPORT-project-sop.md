# 项目专属 SOP 映射 + 多语言约定 —— 实现报告

分支：`pi-subagent/worker-1-c0ad8f7e`（已推送）
工作区：`/root/code/pi-sop/.pi-subagents/runs/r-a96cf281/worktrees/worker-1`
Base：`dea98cf chore: prepare for npm publish`（未改动的 `main`）
提交（本分支，按时间顺序）：
- `64adcfa docs: add implementation report`
- `069d7d0 feat: project-scoped SOP mapping + multi-language conventions`
- `de96095 fix: canonical path comparison in the duplicate guard, findNameConflicts`
- `ceb9072` / `5d0471d` docs: report corrections (commit refs + the worktree slip note)

---

## 1. 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/lib/project.ts` | **新增** | 项目键解析：`normalizeProjectKey()`（5 变体归一同键）、`resolveProjectKeys()`（从 cwd 向上遍历到 `$HOME`/根）、`projectKeyForRepo()`、`projectDir()`（realpath，含目标不存在时对最深已存在祖先做 realpath）、`existingProjectDirs()`。零 spawn / 零网络，纯 `node:fs` |
| `src/lib/probe.ts` | 改（+41） | 新增导出 `readOriginUrlFromGitDir()`（读 config 拿 origin，零 spawn）；`ProbeResult.hasProjectsDir` 新字段；`projects/` 计入合法结构（`usable` 判定与 `sop/`、`MANIFEST.md` 同级） |
| `src/lib/sop.ts` | 改（+198） | `SopDoc.scope`；`listSopFiles()`/`walkProjectFiles()` 全库扫描（`sop/*.md` + `projects/**/*.md`，深度上限 8、跳过隐藏项/node_modules）；`scanSopDir()` 覆盖全库；`findSopConflicts()` / `findNameConflicts()`；MANIFEST 加 `scope` 列；`descriptionHead()` 取双语前段；`countSops()` 统计全库 |
| `src/lib/scaffold.ts` | 改（+23） | 种子 SOP：新「Language（多语言约定）」段落 + `projects/<项目键>/` 布局说明 + 全库唯一性规则 + 双语 description 示例 |
| `src/index.ts` | 改（+213） | `resources_discover` 注入 `[项目目录…, <libDir>/sop]`（项目在前）；`sop_save` 新增 `project?: boolean`；重名守卫；`session_start` 重名告警（每进程一次）；`/sop <关键词>` 标注 scope；`/sop status` 报项目目录数 |
| `test/project.test.ts` | **新增** | 15 例 |
| `test/index.test.ts` | 改（+490） | 20 例（项目注入、写入、守卫、告警、scope 标注、submodule 双键、symlink 库） |
| `test/sop.test.ts` | 改（+158） | 新增 scope 扫描/重名检测/`descriptionHead`/五列表格等 9 例 |
| `test/probe.test.ts` | 改（+59） | 新增 `projects/` 结构、旧库无 `projects/` 不回归、origin 读取 4 例 |
| `test/scaffold.test.ts` | 改（+24） | 五列 MANIFEST + 种子 SOP 多语言/项目段落 3 例 |

**未改动**：`README.md`、`docs/`、`src/lib/config.ts`、`src/lib/sync.ts`、`src/lib/remote.ts`、`src/commands/init.ts`、`.env`/`.git`/`node_modules`。

---

## 2. 功能实现要点

### 2.1 项目键解析（`src/lib/project.ts`）

- **向上遍历**：`resolveProjectKeys(cwd)` 从 cwd 逐级向上，每级调 `projectKeyForRepo()`（复用 probe 的 `resolveGitDir` + `resolveCommonGitDir`）。到 `$HOME` 或文件系统根终止。**`$HOME` 本身被排除**（家目录根的 dotfiles 仓库不是当前工作项目）。
- **归一化**：实测 5 变体同键（测试直接断言）：
  `git@git.woa.com:csig_tdmq/tdmq-appserver.git` / `ssh://git@…` / `https://…` / `git://…`（无 .git）/ 大写 host → `git.woa.com/csig_tdmq/tdmq-appserver`
  额外处理：剥凭据、剥端口、剥 query/fragment、`file://` 与裸本地路径返回 `null`（机器本地路径不是项目身份）、拒绝 `..` 片段（键会变成目录名）。
- **submodule 双键**：`.git` 是文件（`gitdir:` 指针）时**不跳转、继续向上**。子模块走 `resolveGitDir` → `<parent>/.git/modules/<name>`，其 config 里有子模块自己的 origin；父仓库再向上扫描得到父键。返回顺序 = 子模块在前（最具体优先）。
- **出口 realpath**：`projectDir()` 对最深已存在祖先做 realpath 再拼剩余段（写入路径通常尚不存在），symlink 库与真实库归一到同一目录。
- **零 spawn**：`readOriginUrlFromGitDir()` 直接读 config（复用 probe 的 `parseGitConfig`）。

### 2.2 加载 / 写入 / 检索 / 冲突检测

- **`resources_discover`**：`skillPaths = [项目目录(按序，存在的才加)…, <libDir>/sop]`。项目在前 —— pi 的 loader 对同名 skill 保留**先注册者**（读 `node_modules/.../core/skills.js` 确认，且测试用真实 `loadSkills` 验证）。`event.cwd` 优先，无 cwd 时不注入项目目录。已初始化且 `enabled` 的守门沿用现状。
- **`sop_save(project?)`**：默认不传 = 全局；`project: true` 才解析项目键。cwd 无 git / 无 origin → `{saved:false, reason:"no-project"}`，**绝不静默写全局**。返回值新增 `scope` 字段，文案加「范围：」行。
- **重名守卫**：写入前 `findNameConflicts(libDir, slug)` 扫全库（全局 + 所有 projects/），命中且不是同一文件 → 拒绝并给出改名建议（建议前缀取自对侧项目的短名）。同一文件的更新路径用 canonical path 比较放行。
- **MANIFEST**：五列 `name | scope | description | triggers | last_verified`，`scope` 为 `global` 或项目键；`description` 只显示 `|` 前的英文段（前段为空时回退全文）。
- **`/sop <关键词>`**：每条结果后标 `[全局]` 或 `[项目: <键>]`；`/sop status` 额外报「项目专属: N 个项目目录」。
- **`session_start` 冲突检测**：`isSaveable(probe.state)` 时跑 `findSopConflicts()`（纯 fs、不弹 UI、不 await 网络），每组冲突 notify 一次（同进程内同一冲突签名只报一次，`resetNotifyFlag()` 一并清理）。扫描异常被吞掉，绝不影响 session start。

### 2.3 多语言约定

- 种子 SOP 明确：正文单语（作者自选语言，不强制）、triggers 中英混塞、description 可选 `英文 | 中文`（`|` 分隔）、明确写「不做 `.zh-CN.md`/`.en.md` 后缀方案，也不按语言过滤 skill」。
- `sop_save` 的 description 校验不变（必填非空，不强制格式，不改 `description` 字段语义 —— pi 读整条）。
- MANIFEST 取竖线前段；SOP 文件本身保留完整双语（测试双向断言）。

---

## 3. 测试覆盖（新增 51 例，总 189）

| 面 | 用例 |
|---|---|
| 归一化 | 5 变体同键、大小写/尾斜杠/`.git`/凭据/端口/query、无 host 或裸路径或 `..` → null |
| 向上遍历 | 子目录（回归 `resolveGitDir` 返回 null 的坑）、`$HOME` 终止且不含 home 根仓库、根终止不挂死、submodule 双键顺序、worktree 去重 |
| 目录注入 | 项目在前 + 真实 `loadSkills` 能加载到；项目目录不存在时不注入；非 git cwd 不注入；submodule 场景注入两个项目目录；只有 projects/ 没有 sop/ 的库也能服务 |
| 写入 | `project=true` 落 `projects/<键>/` 且不进全局、commit 记录相对路径、MANIFEST 双 scope；默认全局且不建 projects/；无 git/无 origin 拒绝；symlink 库下相对路径正确 |
| 重名守卫 | 全局→项目拒绝、项目→全局拒绝（含建议前缀断言）、跨项目拒绝、同文件更新放行 |
| 冲突检测 | session_start 告警（全局 vs 手工项目文件）且 resume 不重复、无冲突时静默 |
| scope 列 | 五列表头、项目键行、双语截断、管道转义（仍恰好 5 个 cell）、空表标记、换行扁平化 |
| 兼容 | 旧库无 `projects/` 行为不变；`projects/` 单独存在判定为合法结构；种子 SOP 多语言/项目段落 |

---

## 4. 验证输出（原样，`npm run verify`，exit 0）

```
> pi-sop@0.1.0 verify
> npm run typecheck && npm test


> pi-sop@0.1.0 typecheck
> tsc --noEmit


> pi-sop@0.1.0 test
> tsx --test test/*.test.ts
...
ok 189 - run() timeout kills a hanging child and reports timedOut
  ---
  duration_ms: 1005.99785
  type: 'test'
  ...
1..189
# tests 189
# suites 0
# pass 189
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16654.819133
```

基线 138 例 + 新增 51 例 = 189，全绿，无回归。

---

## 5. 与设计偏差及理由

1. **`resolveProjectKeys` 排除 `$HOME` 本身**（设计只说「到 `$HOME` 或根为止」）。实现为「走到 `$HOME` 时不再检测该级」。理由：`~/` 是 dotfiles 仓库时，任何 `~/work/...` 下的 shell 都会被套上 dotfiles 项目；测试固定了这个语义。
2. **`file://` / 裸本地路径 origin → 无项目键**（设计未提）。理由：本地路径键逐机不同，作为跨机共享的目录名毫无意义；退化为全局是这个设计下的正确行为。
3. **`projects/` 计入 probe 合法结构**（设计只写了「projects/ 视为可选合法结构」）。实现让 `git repo + 只有 projects/` 判为 `ready`/`no-remote` 而非 `malformed`。理由：「可选」必须双向 —— 否则一个只放项目 SOP 的库会被 `sop_save` 判 malformed 而拒写。
4. **重名守卫用 canonical path 比较**。设计未指定比较方式。理由：`projectDir()` 出口 realpath，而 `scanSopDir()` 给的是词法路径；symlink 库下朴素字符串比较会把「更新自己」误判成冲突。
5. **冲突告警挂在 `isSaveable(state)` 而非仅 `ready`**。理由：本地库（`no-remote`）同样是正常使用态，用户手写文件在那里一样会撞名。
6. **`descriptionHead` 前段为空时回退全文**（设计只说「取竖线前的段落」）。理由：`| 只有中文` 这种写法取前段会得到空单元格。
7. **未做 aliases.json**（按设计留 TODO，未实现）。

`resolveGitDir` 的「只查 cwd 本身」限制未改动，`project.ts` 用向上遍历绕过（未触碰既有函数语义）。

---

## 6. MR / PR

**未能以编程方式创建**：环境无 `gh` CLI（`which gh` → 空）、无 `GITHUB_TOKEN`、GitHub 匿名 API 配额已耗尽（`rate_limit` → `core: 0/60`）。分支已推送，可直接开 PR：

- **创建 PR**：https://github.com/zzjcool/pi-sop/compare/main...pi-subagent/worker-1-c0ad8f7e?expand=1
- **分支**：https://github.com/zzjcool/pi-sop/tree/pi-subagent/worker-1-c0ad8f7e
- Base = `main`（`dea98cf`，本分支的直接祖先，可安全作为 base）
- push 记录（均无 `--force`，未 push main，未本地 merge）：
  - `* [new branch] pi-subagent/worker-1-c0ad8f7e -> pi-subagent/worker-1-c0ad8f7e`
  - `64adcfa..de96095`（把实现提交补进分支）
  - `de96095..ceb9072`、`ceb9072..5d0471d`（报告修正）
- 远端当前 `refs/heads/pi-subagent/worker-1-c0ad8f7e` = `5d0471d`；`refs/heads/main` 仍为 `dea98cf`（未被触碰）

---

## 7. 未决问题 / 需人工介入

1. **MR 需人工点击创建**（原因见 §6；与上一轮 worker-0 相同的环境限制）。
2. **`last_verified` / 提示文案的 TUI 观感未手测**：`/sop status` 与 session_start 告警的多行 notify 只做了字符串级断言。
3. **远程真实 origin（`git@git.woa.com:...`）不可达**：项目键解析全部基于本地 `.git/config` 的真实内容构造 fixture（含真实 `git submodule add` 产出的 `.git` 文件 + `.git/modules/<name>` 布局），未对真实远端做 `ls-remote`。
4. **过程失误（已修复）**：首轮实现我误在**父 checkout**（`/root/code/pi-sop` 的 `main`）上编辑并提交，导致首批 commit 落在错误的 worktree。已通过 `git reset --hard dea98cf` 将父 checkout 恢复为原始 `main`（`git status` 干净、`src/lib/` 无 `project.ts`），并将两个工作 commit cherry-pick 到本分支（新 SHA `069d7d0` / `de96095`）。本分支后续所有验证均在 worktree 内执行。教训：命令不要带 `cd /root/code/pi-sop` 前缀。

5. **`$HOME` 下的仓库不参与项目键**（见偏差 1）：若用户把项目 clone 到 `~/repo`（直接在家目录下一级），该仓库会被识别；只有 `$HOME` 目录**本身**是仓库时才排除。
