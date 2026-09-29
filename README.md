# HTTP VFS driver

平台无关的文件与进程客户端，只依赖 `vfs-core`。宿主注入 endpoint、凭据解析和可选 fetch；驱动不访问宿主目录，也不依赖工作台或 app-core。

## 接口与所有权

- `HttpFSBackend`：实现 `FileStorageBackend`，`FileStorageAdapter` 负责接入已有 VFS。
- `openHttpFileSource()`：独立文件来源；调用者释放返回的 owner。
- `createHttpSourceProvider(): HttpSourceProvider`：连接检查、目录浏览、能力发现、共享文件来源与独立进程会话的装配入口。
- `RemoteConnection`：只携带凭据引用；口令由宿主存储并解析。
- `HttpProcessSession`：持有配置快照及未确认结束的进程 ID。`release()` 关闭准入并确认清理；失败时可再次调用，不能把网络断开视作进程退出。

Provider 的 `open()` 每次返回独立的释放句柄；相同 endpoint、身份、alias 共享来源。每个调用者独立等待或取消初始化，最后一个引用释放后关闭来源。Provider 的 `dispose()` 负责关闭文件来源；`process()` 返回的执行 owner 必须由执行上下文显式 `release()`，不能因关闭文件视图而中断命令。

## 内部职责

| 位置 | 职责 |
| --- | --- |
| `backend.ts` | VFS 完整文件操作、Range 与路径约束 |
| `protocol/exports.ts`、`stat.ts` | 导出与属性响应校验、强条件写入的启用策略 |
| `stat-batch.ts` | 合并查询、逐订阅者超时与取消 |
| `transport.ts` | 认证请求、生命周期与预算传播 |
| `transport/body.ts` | 有上限的二进制响应读取 |
| `transport/errors.ts`、`mutation.ts` | HTTP 错误映射、写入回执与结果分类 |
| `transport/retry.ts` | GET 重试策略；POST/PUT 不自动重放 |
| `transport/cancellation.ts` | 取消分类与可取消等待 |
| `provider.ts` | 面向宿主的窄接口与组件装配 |
| `provider/source-pool.ts` | 共享初始化、引用计数与单次释放 |
| `process/contracts.ts`、`protocol.ts`、`client.ts` | 进程协议类型、响应验证与 HTTP 路由 |
| `process.ts` | 执行会话、总预算、轮询与清理所有权 |

内部辅助模块不从包根导出。新增策略应扩展对应协议/策略模块，不在工作台或 transport 中复制判断。

## 关键语义

- 批量 stat 的共享请求使用等待者的最长剩余预算；未指定预算者使用连接默认值。各订阅者单独到期，全部退出后中止共享请求。
- 异常 exports 不降级为“目录不存在”；未知名称等价规则不开放写入。
- mutation 的损坏成功响应属于 `unknown`；可确认的拒绝才属于 `not-committed`。未知结果携带 operation ID，不自动重放写入。
- 进程执行从启动到轮询共用总预算，清理使用独立短预算。取消不承诺文件回滚；无法确认退出时保留进程 ID。
- `.gitignore` 属于界面发现策略，不改变驱动的原始文件视图。

## 验证

```sh
pnpm --filter @itookit/vfsdriver-http typecheck
pnpm --filter @itookit/vfsdriver-http build
pnpm --filter @itookit/vfsdriver-http test
FS_AGENT_PROCESS_TEST=1 pnpm --filter @itookit/vfsdriver-http test
```

最后一项启用真实 fs-agent 隔离进程验证，需要 Linux 本地监听与 sandbox 能力。协议设计见 [vfs-http-driver](../../doc/design/vfs-http-driver.md)。
