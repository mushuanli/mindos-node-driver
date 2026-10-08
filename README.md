# @itookit/piagent-driver

PI 表示 Personal Information（个人信息）。

连接 [pi-agent](https://github.com/mushuanli/pi-agent) 的平台无关客户端。pi-agent 是 MindOS 的个人智能节点，将设备上的文件、项目和执行环境接入 MindOS；本包统一封装文件访问、项目管理、同步、进程与原生 AI harness 会话。源码仓库：[piagent-driver](https://github.com/mushuanli/piagent-driver)。

Web、Tauri、CLI 创建 `createPiAgentDriver()`，共用连接和运行期凭据。原 vfsdriver-agent 的文件与进程实现已并入 `src/files`，保留 revision、条件写入、流传输与隔离语义，发布包不再依赖旧驱动。HTTP 同步客户端通过 `/sync` 导出；harness 通过 `/harness` 导出并使用 MCP SDK 2.0.0、协议 2026-07-28。Codex app-server 的原生 stdio 协议留在服务端。

```sh
pnpm add @itookit/piagent-driver
```

```ts
import { createPiAgentDriver } from '@itookit/piagent-driver';

const adapter = createPiAgentDriver();
adapter.setCredential('workstation', password);
const connection = { endpoint: 'http://127.0.0.1:8787', username: 'owner', credentialRef: 'workstation' };
const harness = adapter.harness(connection);
const { profiles } = await harness.profiles();
const sessions = await harness.list(profiles[0].id);
await harness.close();
await adapter.dispose();
```

`setCredential` 返回恢复先前凭据的函数；密码不进入持久连接记录。凭据解析器可以异步注入；工厂第二个参数为 harness 的 fetch 注入点。三个能力分别管理生命周期；`sync()` 返回句柄由消费者关闭，`dispose()` 释放文件 provider 和尚未关闭的 harness 客户端。关闭控制面板不会中断服务端 turn，中断必须显式调用 `interrupt()`。

修改请求携带服务 epoch 和唯一 requestId。断网、超时或失去响应均不自动重放，错误保留 requestId，可用 `operation()` 确认收据。收据和接管关系为服务进程内状态，重启后必须重新发现 profile，不能跨 epoch 重放。每个 profile 保留至多 1024 条收据，不淘汰仍可能被查询的记录；达到上限拒绝新的修改。

当前支持 Codex 的会话分页、归档列表、历史、新建、继续、消息、增量输出、中断、命令/文件审批和用户问题。其他 harness 通过服务端 HarnessPlugin/HarnessDriver 扩展，不改变宿主连接入口。配置和使用见 [pi-agent README](https://github.com/mushuanli/pi-agent#readme)。

验证：`pnpm --filter @itookit/piagent-driver test`、`typecheck`；`PI_AGENT_HARNESS_TEST=1 pnpm --filter @itookit/piagent-driver test tests/network.test.ts` 启动本地 Rust 服务和模拟 Codex，验证真实 MCP 网络链路，不调用模型。

客户端配置入口统一为“工具箱 → MCP”。通用管理器完成标准发现后，由 app-core 注册的 pi-agent 扩展验证 `server/discover._meta['itookit/pi-agent']`，获得同源文件 HTTP 端点、fileProtocol、serverId 和 harness 能力；旧服务只调用已声明的能力工具，普通 MCP 不发专用探测。测试、保存和改名复用验证结果，连接身份变化重新验证。原服务根地址只作为发现结果供文件/同步访问，用户填写完整 `/mcp` 地址。认证解析器也注入通用 MCP 客户端，每次请求读取当前凭据；API Key 使用 MCP 配置存储，项目只保存引用。

driver 独立使用 `discover()` 时也优先消费 SDK 已连接的标准发现元数据，避免额外能力调用；无元数据时兼容 piagent_capabilities，只有工具缺失才尝试旧 fsagent_capabilities。元数据不合法时拒绝，不绕过校验。


`projects(connection)` 提供服务端目录项目的 roots/list/read/register/configure/exec。`register({alias,path,name,access,createDirectory:true})` 在已有父目录下创建一个目录并注册；不创建所有父目录。项目客户端的 `harness(project,{readOnly})` 继承项目 ID/revision，开放对应 profile 的项目 workspace。`projectProcess` 复用原进程取消与回收逻辑，启动时改走服务端项目授权。文件 open 传入 serverProjectId/serverProjectRevision/access 后添加项目上下文 headers；普通文件与旧服务访问保持兼容。

方案及部署见 [项目模型](https://github.com/mushuanli/itookit/blob/v5.3/doc/design/pi-agent-project-model.md)。

Directory materialization is available when discovery returns `directorySync: true`.
Use `projects.directorySync()` to bind a published files dataset to an existing
writable project directory, preview, then execute the returned plan ID. Keep the
binding ID stable. Upload completion and directory application are separate
outcomes. On timeout or partial failure, query `status` and resume the retained
plan; never replace an `applying` plan. Deletes and project mounts are excluded.

目录同步客户端提供目录浏览、方向 CAS 配置、带来源／目标的计划、冲突正文比较与选侧后重新预览。旧服务器只能执行其声明支持的单向能力。piagent_capabilities 是主发现工具；旧 fsagent_capabilities 与 itookit/fs-agent MCP 扩展继续兼容读取。共享 vfs-sync manifest 和文件 HTTP 协议保持已有编码。

## 文件与进程接口

包根保留 `HttpFSBackend`、`openHttpFileSource`、`createHttpSourceProvider`、`HttpTransport`、`HttpProcessSession` 和 `HttpSeqClient`。迁移旧 npm 引用时将 `@itookit/vfsdriver-agent` 改为 `@itookit/piagent-driver`；这些接口的所有权和文件协议保持一致。统一装配优先使用 `createPiAgentDriver()`。

`HttpFSBackend` 实现 `FileStorageBackend`，由 `FileStorageAdapter` 接入 VFS。文件来源按 endpoint、身份和 alias 共享初始化，每次 `open()` 返回独立释放句柄。订阅者取消不会中断其他读取，最后一个引用释放后关闭来源。进程 owner 由执行上下文显式 `release()`，关闭文件视图不表示命令已结束；无法确认退出时保留进程 ID 供重试清理。

`src/files/protocol` 负责响应校验，`transport` 负责认证、预算、取消和错误映射，`provider/source-pool` 负责共享生命周期。网络错误不转成不存在；损坏的写入响应属于未知结果，携带 operation ID，不自动重放写入。内部模块不作为发布子路径导出。

原生历史支持 `read(profile, session, {cursor})` 分页，`inspect` 只读元信息。`HarnessConversation.loadEarlier` 加载更早消息，`branches` 按原生父会话链接列出同一项目中的分支，`fork(name)` 创建原生分支并返回新会话身份，交给宿主切换。只读、空历史、活动或待确认会话不能创建分支；未知结果先查询 receipt，不重复创建。创建与切换不产生本地 Session 或复制历史。

`HarnessSession.createdAt` 与 `updatedAt` 分别表示创建及最后修改的 Unix 毫秒时间，缺失为 null；createdAt 为可选字段以兼容旧服务。驱动统一转换旧服务的秒时间，从 native.createdAt 恢复缺失的创建时间，不用修改时间冒充创建时间。空标题可回退 native.name/preview，展示层使用未命名会话兜底，原生 ID 继续用于路由与操作。

会话消息保留原生 `turnId` 和毫秒 `timestamp`，内容数组中的所有请求、回复均按顺序展开；用户文字项还通过 contentParts 保留边界，展示层在项间插入 Markdown 分隔线，plain-text 预览保持原格式；`branchName` 独立于会话标题，根分支使用 main。`HarnessConversation` 为历史和事件请求 `toolDetail: 'summary'`，工具仅保留名称、操作、首个非空命令行（最多 240 个字符）和目标路径，忽略工具输出增量；旧服务的详细工具数据也在驱动内转换为摘要。`loadEarlier` 合并稳定 ID 并拒绝循环游标，刷新和事件恢复保留已加载的早期页面。itookit 打开后自动逐页补齐到开头，保留加载进度及失败重试入口。总容量为 10,000 条/32 MiB，超过时明确失败并保留现有内容与游标，不静默裁剪。宿主按轮次把请求与该轮全部响应分别投影为一个 Markdown 编辑器。驱动不生成产品界面或改写原生历史。

## 独立开发与发布

```sh
git clone https://github.com/mushuanli/piagent-driver.git
cd piagent-driver
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

TypeScript 配置与依赖独立于 itookit。发布仅包含 `dist`、README 和许可证，根、`/harness`、`/sync` 均提供 ESM、CommonJS 与类型声明。`publishConfig` 使用构建入口；仓库内源码入口用于开发，不进入发布 manifest。

纯单元测试不要求 Rust。Linux 下可指定独立服务器 checkout 进行真实文件与 harness 验证：

```sh
PI_AGENT_MANIFEST=/path/to/pi-agent/Cargo.toml pnpm exec vitest run tests/files/network.test.ts
PI_AGENT_MANIFEST=/path/to/pi-agent/Cargo.toml PI_AGENT_HARNESS_TEST=1 pnpm exec vitest run tests/network.test.ts
```

itookit 内自动发现 `tools/pi-agent`。文件进程隔离测试还需 `PI_AGENT_PROCESS_TEST=1`；harness 网络测试使用模拟 Codex，不调用模型。旧协议标识和历史数据保持兼容，旧包的已发布版本不会被覆盖。
