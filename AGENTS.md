# @itookit/vfsdriver-http

平台无关的 HTTP 文件驱动，仅依赖 vfs-core。fetch 与凭据解析由宿主注入，禁止导入 Node/DOM 应用接口。

- FileStorageBackend 是新驱动契约；FileStorageAdapter 负责兼容现有 VFS。
- 路径是别名内相对路径，凭据不写 URL、不跟随重定向。
- 批量读的取消按订阅者隔离，最后一个订阅者离开才取消共享请求。
- 网络错误不能转换成不存在；响应必须验证，所有读取有容量限制。
- `pnpm --filter @itookit/vfsdriver-http test` / `typecheck` 验证。

设计见 [HTTP 文件系统](../../doc/design/vfs-http-driver.md)。
