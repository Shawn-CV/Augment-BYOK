# 全量工具自检（Super Prompt）

你是一个具备工具调用能力的 AI 代理。你的任务是对当前会话环境中**可用的全部工具**做一次“全量实测”，要求：

## A. 总体要求（必须遵守）
1) **逐个工具真实调用**（不是只列清单），并记录：`工具名 / 调用参数 / 结果摘要 / 成功或失败 / 失败原因（若有）`。  
2) **副作用约束**：  
   - 文件读写/删除/新建，只允许发生在：`BYOK-test/` 目录内。  
   - 禁止修改除 `BYOK-test/` 之外的任何仓库文件。  
3) **外部访问授权**：允许联网；允许打开浏览器；允许 web-fetch。  
4) **命令执行白名单**（严格遵守，不允许执行未列出的命令）：  
   - `pwd`, `ls`, `echo`, `cat`, `node -v`, `python --version`  
   （如果需要验证 write-process/kill-process，可额外请求我允许 `bash` 或 `cat` 交互模式）
5) **不跳步**：任何工具若无法完成实测（例如缺少参数/权限/白名单限制），必须在报告中标记为 `SKIPPED` 并说明缺口与补充条件。  
6) **输出格式固定**：最后输出一个 Markdown 表格（见下文模板），并在结尾给出“未覆盖项清单 + 需要我补充的授权/参数”。

## B. 需要覆盖的工具（按顺序测试）
你必须按下面顺序逐个测试（每个都要有一次真实调用）：

### 1) 文件/目录与检索
- `view`（目录、文件、正则搜索各一次）
- `view-range-untruncated`（先制造一次“被截断输出”，再用它取范围）
- `search-untruncated`（同上，在截断输出里搜索）

### 2) 文件写入/编辑/删除
- `save-file`：创建 `BYOK-test/tool_test.txt`（内容至少 3 行）
- `str-replace-editor`：把其中某行替换/插入（确保 old_str 精确匹配）
- `remove-files`：删除该文件（最后再删）

### 3) 终端/进程
- `launch-process`：分别执行 `pwd`、`ls`、`node -v`、`python --version`
- `list-processes`：列出所有已启动进程/终端
- `read-process`：读取其中一个 terminal 的输出
- `read-terminal`：读取当前活动终端输出
- `write-process`：启动一个可交互进程后写入（若白名单不够，标记 SKIPPED 并说明需要增加的命令）
- `kill-process`：杀掉一个长驻/后台进程（若无可杀对象，标记 SKIPPED 并说明怎么构造）

### 4) IDE 诊断
- `diagnostics`：对 `BYOK-test` 下新建文件跑一次诊断

### 5) 代码库语义检索
- `codebase-retrieval`：查询“BYOK-test 的用途/约定”或类似关键词并展示命中片段

### 6) Web
- `web-search`：查询 `example.com robots.txt`（或等价关键词）
- `web-fetch`：抓取 `https://example.com`
- `open-browser`：打开 `https://example.com`（仅调用一次）

### 7) Mermaid
- `render-mermaid`：渲染一个最小流程图（工具->结果）

### 8) 任务列表
- `view_tasklist`
- `add_tasks`：新增一个“全量测试”子任务（确保参数合法）
- `update_tasks`：把该任务标记为 IN_PROGRESS 再标记 COMPLETE
- `reorganize_tasklist`：对任务列表做一次最小重排（例如把新任务放到最前或调整层级）

### 9) 记忆
- `remember`：写入长期记忆：`BYOK-test 是工具全量测试目录`

## C. 报告输出模板（必须使用）
最终输出一个表格：

| 工具 | 调用目的 | 关键参数（精简） | 结果（精简） | 状态(SUCCESS/FAIL/SKIPPED) | 备注/失败原因 |
|---|---|---|---|---|---|

并在表格后追加：
1) **未覆盖项清单**（若有）  
2) **为达到 100% 覆盖你需要我补充的授权/参数**（例如需要将白名单增加 `bash`）

开始执行。工具调用请尽量并行（能并行的就并行），但要保证不会互相依赖冲突（例如先创建文件再编辑、先启动进程再读写/kill）。