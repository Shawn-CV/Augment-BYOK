# ENDPOINTS：71 / 13（上游端点范围）

数据源：
- `.cache/reports/upstream-analysis.json`（端点全集；`npm run upstream:analyze`）
- `dist/endpoint-coverage.report.md`（LLM 端点覆盖矩阵；`npm run report:coverage`）

默认策略：
- BYOK 运行时代码只对 **13 个 LLM 数据面端点**提供语义实现（其余端点保持 official，或按需 disabled）。

## 13 个 LLM 数据面（BYOK 语义实现）

- `callApi`（6）：`/get-models`、`/chat`、`/completion`、`/chat-input-completion`、`/edit`、`/next_edit_loc`
- `callApiStream`（7）：`/chat-stream`、`/prompt-enhancer`、`/instruction-stream`、`/smart-paste-stream`、`/next-edit-stream`、`/generate-commit-message-stream`、`/generate-conversation-title`

## 其余 58 个端点（非 LLM，默认 official）

说明：这些端点依赖控制面/权限/状态机/集成能力，单 VSIX BYOK 不复刻；建议 official（或按需 disabled）。

- Remote Agents（15）：`/remote-agents/create`、`/remote-agents/update`、`/remote-agents/delete`、`/remote-agents/list`、`/remote-agents/list-stream`、`/remote-agents/chat`、`/remote-agents/get-chat-history`、`/remote-agents/agent-history-stream`、`/remote-agents/logs`、`/remote-agents/interrupt`、`/remote-agents/pause`、`/remote-agents/resume`、`/remote-agents/resume-hint`、`/remote-agents/generate-summary`、`/remote-agents/add-ssh-key`
- Agents / Tools（6）：`/agents/check-tool-safety`、`/agents/revoke-tool-access`、`/agents/list-remote-tools`、`/agents/run-remote-tool`、`/agents/edit-file`、`/agents/codebase-retrieval`
- 文件/Blob/上下文同步（7）：`/batch-upload`、`/checkpoint-blobs`、`/find-missing`、`/save-chat`、`/context-canvas/list`、`/get-implicit-external-sources`、`/search-external-sources`
- GitHub（4）：`/github/is-user-configured`、`/github/list-repos`、`/github/list-branches`、`/github/get-repo`
- 账号/订阅/权限/Secrets（7）：`/token`、`/get-credit-info`、`/subscription-banner`、`/settings/get-tenant-tool-permissions`、`/user-secrets/list`、`/user-secrets/upsert`、`/user-secrets/delete`
- 反馈/遥测/调试（17）：`/chat-feedback`、`/completion-feedback`、`/next-edit-feedback`、`/client-metrics`、`/client-completion-timelines`、`/record-session-events`、`/record-user-events`、`/record-preference-sample`、`/record-request-events`、`/report-error`、`/report-feature-vector`、`/resolve-completions`、`/resolve-chat-input-completion`、`/resolve-edit`、`/resolve-instruction`、`/resolve-next-edit`、`/resolve-smart-paste`
- 通知（2）：`/notifications/read`、`/notifications/mark-as-read`
