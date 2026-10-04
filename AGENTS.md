# @itookit/vfsdriver-agent

平台无关的 HTTP 文件驱动，仅依赖 vfs-core。fetch 与凭据解析由宿主注入，禁止导入 Node/DOM 应用接口。

- FileStorageBackend 是新驱动契约；FileStorageAdapter 负责兼容现有 VFS。
- 路径是别名内相对路径，凭据不写 URL、不跟随重定向。
- 批量读的取消按订阅者隔离，最后一个订阅者离开才取消共享请求。
- 网络错误不能转换成不存在；响应必须验证，所有读取有容量限制。
- 失败在 console 记录 `[fs-agent]` 请求方法、服务地址、路由/文件路径、发送阶段和取消来源，并保留错误链；不得记录请求 headers、凭据或正文。
- `pnpm --filter @itookit/vfsdriver-agent test` / `typecheck` 验证。

设计见 [HTTP 文件系统](https://github.com/mushuanli/itookit/blob/v5.3/doc/design/vfs-http-driver.md)。

内部职责与所有权见 [README](./README.md)。策略放在协议/策略模块，transport 不承载项目授权；共享来源与执行会话分别持有生命周期。

`HttpSourceProvider.transport(connection)` 提供复用凭据的通用 HTTP 通道，调用方释放生命周期。HttpSyncClient 位于 `@itookit/sync-adapters`，驱动不依赖 sync-core，不持有本地同步状态或决定项目绑定。

`HttpSeqClient` 使用 SQLite SeqFile snapshot / conditional transaction 接口；只提供单文件事务和既有 operation 回执，不能作为跨文件的 IRecordStore 事务宣告。正文存储位于 export，与 sync 对象库分开。

独立仓库通过 `vendor/vfs-core` 固定开发契约；默认单元测试不依赖应用包。`FS_AGENT_MANIFEST` 显式指定独立服务器的 Cargo.toml，可执行真实网络集成测试。
