# ROADMAP

- P0：补丁面冻结 + guard（injector/bootstrap/no autoAuth）
- P1：MVP（ConfigManager/Router、`/chat-stream`、rollback）
- P2：补齐其余 LLM 数据面端点（除 `/chat-stream` 外）
- P3：`/get-models` + model registry + 默认模型策略
- P4：hardening（契约回放、错误/超时归一、上游升级 fail-fast）
