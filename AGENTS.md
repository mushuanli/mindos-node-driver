# @itookit/piagent-driver

平台无关的 pi-agent 接入层。文件与进程实现位于 src/files，同步 HTTP 协议与 harness MCP 协议归本包。不得依赖旧 vfsdriver-agent 包。
不得依赖 app-core、UI 或宿主 API。连接配置与目录授权策略归 app-core；凭据解析与 fetch 由宿主注入。
文件、同步与 harness 各自拥有生命周期。关闭控制面板只关闭客户端等待，不把连接断开当作 turn 已停止。
修改操作携带 epoch 与 requestId；结果未知时查询 receipt，不自动重放。
验证：pnpm --filter @itookit/piagent-driver test / typecheck。

FileStorageBackend 是文件契约；共享文件来源与独立执行会话分别持有生命周期。批量读的取消按订阅者隔离，最后一个订阅者离开才取消共享请求。
网络错误不能转换成不存在；响应必须验证，所有读取有容量限制。日志不记录 headers、凭据或正文。
目录监听失败与 profile 会话观察隔离；观察失败保留最近投影并标 stale/refreshError，只有传输失败证据或原生断开事件标 offline。events/list 各阶段使用相同传输证据，协议、权限错误与超时只标 stale。成功轮询即恢复传输状态，不等待新事件；原生断开仍等待原生状态或权威快照恢复。诊断按阶段和安全错误码去重，不记录原始异常正文。
独立仓库不依赖 itookit 的 tsconfig 或私有源码；发布根、harness 与 sync 的 ESM/CJS/类型入口。
