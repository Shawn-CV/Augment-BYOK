# augment-interceptor（vendor）

此目录用于**自包含构建**：固定必须注入的拦截器代码（byte-level 不可改），构建时会 prepend 到上游 `extension/out/extension.js`。

- 文件：`inject-code.augment-interceptor.v1.2.txt`
  - 历史来源：`AugmentBYOK/references/Augment-BYOK-Proxy/vsix-patch/inject-code.txt`（本仓库构建不依赖该路径）
  - 构建注入：`tools/patch/patch-augment-interceptor-inject.js`
  - 一致性：sha256 写入 `upstream.lock.json` 与 `dist/upstream.lock.json` 的 `interceptorInject.sha256`（用于增量审查）
