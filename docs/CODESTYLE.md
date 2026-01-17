# CODESTYLE

硬规则（为避免再次结构失控）：

- 单文件 ≤ 400 行；单函数 ≤ 80 行；单模块单职责
- patch 薄、域层厚：注入只交控制权给 shim；逻辑放在 `payload/extension/out/byok/*`
- 失败可控：异常必须可回落 official（`return undefined` / empty stream）
- 运行时只用 `fetch` + 基础工具；避免 `child_process` 等高风险面
- 日志必须脱敏（永不输出 key/token 全文）

备注：运行时代码为 CommonJS JS；类型边界用 `normalize/validate` 固定形状。
