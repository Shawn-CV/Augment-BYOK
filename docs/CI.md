# CI（rolling release + 增量审查）

工作流：
- `build-release`：`push main` 构建 VSIX，更新 Release tag `rolling`，并上传审计产物
- `upstream-check`：定时拉最新上游 VSIX，版本变化则 PR 更新 `upstream.lock.json`

审计产物（diff 入口）：
- `upstream.lock.json`（上游版本/sha256 + injector sha256）
- `dist/upstream.lock.json`（构建产物锁：output sha + 时间戳）
- `dist/endpoint-coverage.report.md`（LLM 端点覆盖矩阵）
- `.cache/reports/upstream-analysis.json`（workflow artifact：端点全集/call kind）

fail-fast（直接阻断构建）：
- patch needle 缺失（避免 silent break）
- 命中 `autoAuth` 字符串
- BYOK 合约检查失败（`tools/check/byok-contracts.js`）
- LLM 端点集合变化（需人工确认并更新 allowlist）
