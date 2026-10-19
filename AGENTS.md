# @itookit/mindos-node-client

平台无关的 mindos-node 接入层。文件与进程实现位于 src/files，同步 HTTP 协议与 harness MCP 协议归本包。不得依赖旧 vfsdriver-agent 包。
不得依赖 app-core、UI 或宿主 API。连接配置与目录授权策略归 app-core；凭据解析与 fetch 由宿主注入。
文件、同步与 harness 各自拥有生命周期。关闭控制面板只关闭客户端等待，不把连接断开当作 turn 已停止。
修改操作携带 epoch 与 requestId；结果未知时查询 receipt，不自动重放。
原生命令由 profile.capabilities.slashCommands 协商，commands 查询会话目录、command 执行并沿用 receipt；不在客户端按 harness 名猜测命令或 RPC。命令与普通 turn 分开，命令可无 turnId；未知操作保存 inputText，核对接纳时只清理匹配草稿，保留后续输入。旧节点不宣称能力时不发新协议请求。
验证：pnpm --filter @itookit/mindos-node-client test / typecheck。

FileStorageBackend 是文件契约；共享文件来源与独立执行会话分别持有生命周期。批量读的取消按订阅者隔离，最后一个订阅者离开才取消共享请求。
网络错误不能转换成不存在；响应必须验证，所有读取有容量限制。日志不记录 headers、凭据或正文。
目录监听失败与 profile 会话观察隔离；观察失败保留最近投影并标 stale/refreshError，只有传输失败证据或原生断开事件标 offline。events/list 各阶段使用相同传输证据，协议、权限错误与超时只标 stale。成功轮询即恢复传输状态，不等待新事件；原生断开仍等待原生状态或权威快照恢复。诊断按阶段和安全错误码去重，不记录原始异常正文。
独立仓库不依赖 itookit 的 tsconfig 或私有源码；发布根、harness 与 sync 的 ESM/CJS/类型入口。

原生模型通过 profile.capabilities.models 协商，models 只投影安全目录及按模型区分的推理选项。selection 随 turn 或 prompt command 捕获，按当前目录验证，不映射为本地 Connection 档位；旧节点不发新查询，无效配置不提交提示词。


消息与 prompt 命令共用会话准备、版本化草稿接纳和提交后刷新；尚无会话时禁用 action。pending 保留原始输入及草稿版本，不能用规范化 slash 文本清理草稿。最近 64 个 commandId 结果进入恢复记录，原生同 ID 历史优先；回执接纳与 handler 成败分开。

HarnessRecovery 持久化最近已接纳的 submittedTurnId，重开后与 pending / draftRevision 一起核对输入；模型执行是否完成与提交接纳分开，不因 UI 关闭丢失接纳事实。

可选 submissionId 将宿主冻结提交关联到 turn/command 的稳定 requestId；HarnessRecovery 保存独立 submission 的 pending/accepted/rejected 回执，准备子操作仍使用独立请求。核对 create/resume 只确认准备，不接纳未发出的 turn；接纳后存储失败保持 unknown，不能把存储冲突当作原生未执行。
