# Augment-BYOK

单一 VSIX：把 Augment 的 **13 个 LLM 数据面端点**按路由转到 BYOK（支持 Streaming），其它端点保持官方行为；支持运行时一键回滚（无需 Rust/外部服务）。

## 安装（推荐：Releases）

- GitHub Releases（tag：`rolling`）下载 `augment.vscode-augment.*.byok.vsix`
- VS Code → Extensions → `...` → `Install from VSIX...` → Reload Window

## 配置

- `BYOK: Open Config Panel`：填写 `official` + ≥1 个 `provider` → `Save`
- `Self Test`：可选，一键验证 models / chat / chat-stream
- 配置存 `globalState`（含 Key/Token）；字段/限制见 `docs/CONFIG.md`

常用命令：
- `BYOK: Enable` / `BYOK: Disable (Rollback)`
- `BYOK: Reload Config`
- `BYOK: Clear History Summary Cache`

## 本地构建

前置：Node.js 20+、Python 3、可访问 Marketplace  
命令：`npm run build:vsix`  
产物：`dist/augment.vscode-augment.<upstreamVersion>.byok.vsix`

## 文档

- 索引：`docs/README.md`
- 配置/路由：`docs/CONFIG.md`
- 端点范围（71/13）：`docs/ENDPOINTS.md`
- 架构/补丁面：`docs/ARCH.md`
- CI/Release：`docs/CI.md`
