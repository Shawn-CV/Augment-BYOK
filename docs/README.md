# docs/

文档以“单一真相 + 交叉引用”为原则：每条信息尽量只在一个地方定义。

- `../README.md`：安装/使用（Releases/面板/回滚/构建）
- `CONFIG.md`：配置字段/路由语义/限制
- `ENDPOINTS.md`：端点范围（71 / 13）
- `ARCH.md`：构建/补丁面/模块边界
- `CI.md`：CI/rolling release/审计产物
- `ROADMAP.md`：路线图
- `TESTPLAN.md`：回归 checklist
- `CODESTYLE.md`：硬规则

推荐阅读顺序：
- 使用：`../README.md` → `CONFIG.md`
- 开发：`ARCH.md` → `CONFIG.md` → `ENDPOINTS.md`
- 审查：`CI.md` → `ARCH.md` → `ENDPOINTS.md`
