# pi-sop v0.4.0 —— 机器无关配置 + 会话启动自动克隆（交付报告）

日期：2026-10-10 · 流程：三路侦察 → 冻结契约 → worker×3 → reviewer×2 → 合并 → 现场部署验证

## 1. 问题（本机实测确诊）

`~/.pi/agent/pi-sop.json` 会被跨机器配置同步（tar，见 SOP `sync-pi-config-to-herdr-machines`）原样搬运。
`libDir` 是绝对路径，换机器后成为死路径。本机实例：`libDir: /Users/zzj/sop-library`（macOS 路径）在
Linux 上不存在 → 插件**静默死亡**：

- `initializedAt` 已设置 → 连「未初始化」提示都被压制（旧代码的 bug）
- `probe.state=missing` → 不同步、不注册 skillPaths → 全局 SOP skill 自 10-08 起断供
- 而 `~/sop-library` 明明存在并有近期提交 —— 死路径拦截了解析，插件看不见它

## 2. 方案（冻结契约，两轮实现 + 对抗审查）

核心：**配置存机器无关的仓库地址，插件启动时自愈**。

1. **`repo` 字段**（`pi-sop.json`）：SOP 库的 git 远端地址，跨机器随便搬。schema v1 向前向后兼容。
2. **resolveLibDir「存在的路径赢」**：死 `libDir` 记入 `stale` 继续下探 → 默认 `~/sop-library` 存在则直接赢；
   缺失且 `repo` 非空 → 附带 `autoClone` 候选。env `PI_SOP_DIR` 永远最高优先且永不触发自动克隆。
3. **session_start**（永不阻塞、永不弹窗）：
   - usable 且 probe 到 remote 而 config 无 repo → 自动回填（老用户无感自愈）
   - missing + autoClone 候选 → 后台 fire-and-forget `git clone`；失败后 1.5s 有界复探（并发克隆竞态：
     两个 pi 进程同时启动，一方 clone 时另一方撞「目录已存在」→ 复探后按对方成功处理）
   - 克隆成功但 malformed → 仅告警，**禁止后台 scaffold**（机器不替人做不可逆决策）
   - 修复静默死亡：`initializedAt` 不再压制 missing 提示
4. **/sop init**：`finish()` 仅在 `config.repo` 为空时回填 origin（fork 场景不覆写用户配置的克隆源）；
   `configureRemote` 持久化 repo；status 显示「远端仓库」行 + stale 回退提示。
5. 措辞统一「在本机不可用」（涵盖被文件占用等场景）；克隆失败文案单一来源。

提交链：`a52ed29`（实现）→ 一审 request-changes（finish 无条件覆写 repo 等 6 项）
→ `fc84f0d`（修复）→ 二审 approve-with-nits（1 minor + 2 nit）
→ `5ce48f6`（nits 清理：可注入延迟、文案、冗余）→ fast-forward 合并 main。

测试：204 → 224（净增 20），`npm run verify` 全绿（typecheck + 224/224），套件 ~12s。

## 3. 部署与现场验证（本机）

1. **安装方式迁移**：`pi remove npm:pi-sop` + `pi install git:github.com/zzjcool/pi-sop`
   —— npm registry 凭据不可用（whoami 401），改用 pi 原生 git 源（`~/.pi/agent/git/…`），
   以后 `pi update` 直接从 git 拉，与本次「机器无关」主题同构。**注意**：npm/git 双声明会扩展冲突，
   必须先 remove 再 install（同类坑已在 SOP 库有记载）。
2. **解析自愈验证**（真实 config 跑新代码）：`stale=/Users/zzj/sop-library` 被绕过，
   `dir=/home/zzjcool/sop-library`（ready），下次 session_start 自动回填 `repo`。
3. **端到端验证**（`/tmp/pi-sop-e2e` 新会话）：system prompt `available_skills` 含 15 个
   `~/sop-library/sop/*.md`（含 `writing-sops`）——10-08 起断供的 skill 正式恢复。
   `pi-sop.json` 已含 `repo: git@github.com:zzjcool/sop.git`，`lastSyncAt` 更新到验证会话时刻。
4. **写回闭环验证**：用 0.4.0 新解析路径保存 SOP `pi-config-cross-machine-absolute-path`
   （本坑的教训，触发词含「静默死亡/silent death/absolute path」）→ MANIFEST 重建 + commit + push
   全链路成功（`d42997a`，origin/main 已包含）。中途 EACCES 是当前会话进程仍持旧 0.3.0 内存代码所致，
   新会话自动用新版本——验证了「下次会话生效」的时序设计。

## 4. 跨机器生效路径（其他机器无需任何操作）

`pi-sop.json` 被同步工具原样搬到新机器后：死 `libDir` 自动下探到该机器的 `~/sop-library`；不存在时，
`repo` 字段驱动 session_start 后台自动 `git clone`。同步 SOP（`sync-pi-config-to-herdr-machines`）
的打包清单**无需再手工改 libDir**——这正是本次要消灭的手工步骤。

## 5. 遗留

- npm 发版未做（registry 未登录）；git 源安装已覆盖，npm 可后补或弃用
- 旧机器升级方式：`pi update`（git 源）或 npm 发 0.4.0 后 `pi update --extensions`
- MR #2 已随 main 合并自动关闭；远端陈旧 worker 分支已清理，仅剩 main
