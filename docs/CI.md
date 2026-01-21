# CI（rolling release + 增量审查）

工作流：
- `build-release`：`push` 默认分支（`master`/`main`）构建 VSIX，更新 Release tag `rolling`，并上传审计产物
- `upstream-check`：定时拉最新上游 VSIX，版本变化则 PR 更新 `upstream.lock.json`

审计产物（diff 入口）：
- `upstream.lock.json`（上游版本/sha256 + injector sha256）
- `dist/upstream.lock.json`（构建产物锁：output sha + 时间戳）
- `dist/endpoint-coverage.report.md`（LLM 端点覆盖矩阵）
- `.cache/reports/upstream-analysis.json`（workflow artifact：端点全集/call kind）

备注：
- GitHub Release assets 不能同时存在两个同名文件；因此 `build-release` 上传到 Release 时，会把 `dist/upstream.lock.json` 复制为 `dist.upstream.lock.json`（仅用于 Release 资产命名去重）。
- `upstream-check` 需要创建 PR 时：请在仓库 `Settings -> Actions -> General -> Workflow permissions` 中开启 `Read and write permissions`，并勾选 `Allow GitHub Actions to create and approve pull requests`；否则会报 `GitHub Actions is not permitted to create or approve pull requests.`。
- 若组织策略禁止开启上述选项，可创建 fine-grained PAT（至少 `Contents: Read and write` + `Pull requests: Read and write`），保存为仓库 Secret `UPSTREAM_PR_TOKEN`，workflow 会自动优先使用该 token 来创建 PR。

fail-fast（直接阻断构建）：
- patch needle 缺失（避免 silent break）
- 命中 `autoAuth` 字符串
- BYOK 合约检查失败（`tools/check/byok-contracts.js`）
- LLM 端点集合变化（需人工确认并更新 allowlist）
