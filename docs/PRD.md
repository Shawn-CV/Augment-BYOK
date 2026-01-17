# PRD

定位：单 VSIX、进程内 BYOK shim；**只接管 13 个 LLM 数据面端点**；可运行时一键回滚。

## Goals

- 协议：对齐 Augment 自定义协议（重点 `/chat-stream` NDJSON + tool use）
- 路由：端点级 `byok | official | disabled`
- 配置：`globalState` 持久化 + 面板手填 + `Save` 热更新
- 稳定性：错误归一、超时/取消可控、上游升级 fail-fast

## Non-goals

- 不复刻控制面/编排（Remote Agents、权限、Secrets、日志、集成等）
- 不引入 settings/env/yaml/SecretStorage 作为配置源
- 不做 autoAuth

## Constraints

- 不污染/不读取 `augment.advanced.*` settings
- 构建产物必须包含 injector；`autoAuth=0` guard 必须通过

## Acceptance

- BYOK 关闭：回到官方链路（可立即恢复）
- BYOK 开启：13 个 LLM 数据面端点按路由工作（见 `ENDPOINTS.md`）
