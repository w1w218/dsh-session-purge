# dsh-session-purge

DSH Web 插件：在设置里增加「会话清理」页，**真正删除归档会话**并**回收不再被任何会话引用的附件 blob**。

入口：设置面板 → 左侧导航「会话清理」。

## 安装

需要已安装 DSH（Desktop 或 Web profile 均可）。

```bash
git clone https://github.com/w1w218/dsh-session-purge.git
cd dsh-session-purge
dsh plugin --profile <profile> add .
```

把 `<profile>` 换成你的 profile 名（Desktop 默认是 `desktop`，Web 默认是 `web`）。也可以不用命令行：在 DSH 的插件管理器里选择「安装本地 bundle」，指向这个目录。

安装后需要重启一次 DSH，设置面板里会出现「会话清理」。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-session-purge
```

## 能做什么

- 列出归档集合里的会话：标题、ID、转录大小、附件引用数、是否运行中、是否有 subagent 子会话。
- 勾选目标后一次性执行：
  1. 从所有工作区成员表中移除（`Workspace.detachSession`，持久化）。
  2. 从归档集合中移除（`workspaceRegistry.unarchiveSession`，持久化）。
  3. 删除会话转录目录（整目录，含旧代际日志）。
  4. 删除 `storages/session_projcache/sessions/<id>.json` 投影缓存记录。
- 可选的回收项（默认全开）：
  - 连带删除选中会话的 subagent 子会话（递归）。
  - 回收**独占**附件对象：只被被删会话引用、且没有任何幸存的会话引用。
  - 回收**孤儿**附件对象：磁盘上存在但已无任何会话引用（含以前删除遗留的）。
  - 清空 `cache/attachments/request-images` 派生图缓存（会按需重建）。
- 删除前自动备份 `storages/workspace.json`（备份失败则整个操作不执行）。
- 删除成功后通过 `api-session/removed` 通知所有已连接页面，侧边栏对应行立即消失，不需要刷新或重启。

## 安全设计

- **不退出 DSH**，也不直接改 `workspace.json`：所有的归档/归属变更都走官方 registry API，运行中与磁盘状态一致，无需重启宿主。
- **只处理归档会话**：请求里的 id 必须出现在归档集合中，否则整批拒绝；级联子会话是唯一例外。
- **运行中会话拒绝删除**：以 `ctx.agents.get(id)?.status === 'running'` 判定（与官方归档准入同一口径）；已加载但空闲（idle）的会话会先 `sessions.flush()` 再删除。
- **fail-closed**：只要有一个「幸存会话」的日志无法解码，就无法证明附件是否仍被引用，整次操作中止、一个文件都不删。
- **路径边界**：所有待删路径必须严格位于预期根目录内（`sessions/`、`attachments/v1/`、`session_projcache/sessions/`、`cache/`），非直接子项与符号链接一律拒绝。
- **认证**：HTTP 接口复用官方 `connection.admit()` 的 Host/Origin 校验与浏览器 cookie 认证；只接受 POST + JSON。
- **先记账、后删文件**：记账失败时转录原样保留、可重试；文件删除失败会留下不可见但可再次清理的残留，并在结果中列出。

## 删除范围的判定

- 引用扫描读取磁盘上**全部**会话转录（含未归档、子会话、多代际日志文件），用 `sha256:<64hex>` 匹配附件 id。
- 「幸存引用」= 删除后仍存在的会话目录的引用并集；只有不在幸存引用里的对象才会被回收。
- 若某会话的转录目录已被上次操作删掉、但归档集合里还留着 id，则只清理记录，不报错。

## 已知边界

- 附件引用基于日志文本匹配，偏保守（例如工具参数里出现的 `sha256:...` 也会算作引用），不会误删。
- 标题取自会话日志里最后一条 `session/title` 事件；没有标题的会话显示会话 ID。
- 设置页里的列表在删除后会重新扫描；其他已打开的页面依靠 `api-session/removed` 即时更新。
- 不清理 `dsh-spill-*` 临时目录（在系统临时目录，交由宿主既有清理策略处理）。
- DSH home 取 `$DSH_HOME`，否则 `~/.dsh`。

## 自测

```bash
node test/self-test.mjs
```

覆盖：扫描/独占与孤儿识别、标题提取、转录与缓存删除、共享 blob 保留、workspace detach 与 unarchive 调用、客户端移除事件、备份生成、损坏幸存日志中止、运行中会话拒绝、idle live 会话删除、非归档 id 拒绝。

## 说明

本插件针对 DSH 0.2.2-rc.1 的公开 Service 契约实现；不替换官方 `workspace` 行、不读取宿主私有成员。

## 许可

MIT
