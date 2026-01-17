# TESTPLAN（最小回归清单）

## 构建期（自动）

- patch marker 存在（避免重复注入）
- guard：产物不含 `/autoAuth` / `handleAutoAuth` / `__augment_byok_autoauth_patched`
- guard：injector marker 存在（`Augment Interceptor Injection Start/End`）
- `node --check out/extension.js`
- BYOK 合约检查（`tools/check/byok-contracts.js`）

## 运行期（手动）

- BYOK 关闭：Augment 原生可用（“不破坏原生”是默认态）
- BYOK 开启：面板填写 `official` + ≥1 provider；`/chat-stream` 流式输出 OK；Abort OK（或直接跑 `Self Test`）
- 热更新：面板 `Save` 后下一次请求生效；错误配置不崩溃（保留 last-good）
- 回滚：`BYOK: Disable (Rollback)` 后立即回到官方链路
- 错误：缺 key / 401/429/5xx / timeout 信息可读且不泄露 key/token
