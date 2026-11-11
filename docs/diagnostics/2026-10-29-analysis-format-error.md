# 作文分析格式异常：排查与修复（2026-10-29，未部署）

截图中的「正在识别作文。AI 返回格式异常，请重新分析」最可能发生在 OCR 模型输出校验阶段。依据是：页面将 reading_images 和 saving_ocr 都显示为「正在识别作文」，CloudAnalysisPipeline 在 OCR adapter 返回后才推进 saving_ocr；旧 VisionOcrAdapter 将 JSON 解析、schema、页数、索引、段落与区域业务校验的所有异常都压成裸 AI_INVALID_RESPONSE，且不进行模型修复。截图没有任务 ID、数据库 error_code 或原始模型响应，不能确认具体哪一个字段失败，也不能据此断言线上已经修复。

## 触发路径与分类

调用链为 worker/index.ts 的 queue → CloudAnalysisPipeline.run → VisionOcrAdapter.recognize → 保存 OCR checkpoint → CompositionReviewAdapter.analyzeText → 保存批改。queue 捕获异常，经 analysisFailureCode 写入 analysis_jobs.error_code，D1AnalysisJobs 通过 describePublicAnalysisFailure 转成前端 message。未部署的本机路径由 AnalysisWorker 执行同类步骤。

旧摘要并非仅指 JSON 语法错误。它是 AI_INVALID_RESPONSE 及其未命中更具体分支的后缀码的兜底；因此 OCR 的全部校验失败、内容阶段未单列文案的语义校验失败，以及老版本 adapter 的无细分错误都可能触发。本机 Worker 还曾丢弃 adapter 的细分码。

| 情况 | 修复前 | 修复后 |
| --- | --- | --- |
| OCR JSON/schema/定位不合法 | 裸 AI_INVALID_RESPONSE，无修复 | 本地语法恢复 + 至多一次携原图修复；ocr_json_parse、ocr_schema_路径_类型、ocr_page_count、ocr_page_order 等 |
| OCR 输出截断 | 未检查 finish_reason，可能当作普通格式异常 | 提高输出上限重试一次；仍截断记 ocr_output_truncated |
| 内容模型格式漂移 | 已有一次模型修复及批注 salvage | 复用本地 JSON 恢复与额外字段清理，仍执行报告及语义校验 |
| 请求或成功响应体读取超时 | 请求超时被包装为一般请求失败；body 错误可能被吞 | AI_REQUEST_FAILED_request_timeout，前端明确提示超时 |
| 上游 HTTP 4xx | 通常可区分，但 provider code 含 json_parse/invalid_type 时会误判 | HTTP 分类优先；区分内容／视觉请求，保留状态及已脱敏详情 |
| 队列超时／Worker 中止 | ANALYSIS_TIMEOUT / ANALYSIS_ABORTED | 保持独立分类，不走格式错误提示 |
| 上游 200 信封损坏 | 一般请求失败或普通异常 | AI_INVALID_RESPONSE_response_envelope |

队列捕获失败后会落库并 ack，当前没有在 Cloudflare queue 层自动重试普通模型异常；此次修复不改变该调度策略。OCR adapter 最多两次模型调用。本机 durable worker 仍按原有尝试上限重试，并保留细分码；永久上游 4xx 不重试，408、429 和 5xx 允许按上限重试。

右侧残留红批不是本次 OCR 已经部分成功的证据：失败更新只更改状态，不清除上一版报告与批注。新增 queue → D1 → 公开任务视图的测试明确检查失败时保留旧报告。

## 恢复边界与改动文件

本地恢复只处理 Markdown/前后说明、字符串外尾逗号、字符串内裸控制字符；提取 JSON 时识别引号和转义，避免说明中的花括号污染结果。不会猜测补全缺失引号、括号、字段或截断正文。OCR 忽略 schema 外的元数据（包括模型自定段落 ID），允许省略非正文 warnings/blocks；必需正文、段落与区域仍严格校验。修复模型请求包含原图，失败输出被标为待处理数据。最终 OCR 细分码同时进入不含正文的错误详情，方便后续定位。

- src/ai/adapter-shared.ts：共享恢复、校验细分码、响应信封校验、请求超时分类；复用原内容 adapter 的额外字段清理。
- src/ai/vision-ocr-adapter.ts：OCR 恢复、一次模型修复、截断重试和具体校验码。
- src/ai/composition-review-adapter.ts：复用共享恢复及字段清理；保持现有模型修复和批注 salvage。
- src/ai/openai-review-adapter.ts：兼容客户端类型声明 finish_reason。
- src/cloudflare/worker-openai-client.ts：保留响应体读取异常；区分 200 信封损坏和 HTTP 拒绝。
- src/jobs/analysis-worker.ts、analysis-job-repository.ts：本机持久任务保留细分码、安全码长度及重试策略兼容。
- src/jobs/public-analysis-failure.ts：OCR、JSON、超时、HTTP、响应信封分别说明；HTTP 状态只从规定的错误码前缀提取，避免把字数或数组下标 500 当成 HTTP 500。
- app/(protected)/reviews/ReviewPage.tsx：失败提示使用错误颜色，并显示「分析失败」，避免仍声称「正在识别」。

对应 adapter、worker、queue、公开文案和页面测试已补充。修复不包含数据库迁移、不改线上数据、不执行 wrangler deploy。

## 验证

使用本机 Node 24.18.0（默认 Node 22 与现有 better-sqlite3 原生模块 ABI 不兼容）：

```sh
PATH=/Users/micky/.local/share/nodejs/v24.18.0/bin:$PATH npm test -- src/ai src/ocr src/jobs src/cloudflare 'app/(protected)/reviews/ReviewPage.test.tsx'
```

全项目 tsc --noEmit 仍被未改动的 src/domain/model-essay-sync.test.ts 中 teacherReviewedAt 缺失／重复，以及 src/grading-opinions/grading-opinions.test.ts:215 的可空值报错阻止；本次改动文件未出现类型错误。最终验证：38 个测试文件、530 项测试全部通过；本次改动文件的 ESLint 为 0 错误、3 条原有的未使用变量警告；git diff --check 通过。

当前沙箱只允许写入 worktree，不允许修改主仓库的 .git；普通暂存即因 index.lock 无权限而失败。因此本次提交在 tmp/format-error-2026-10-29/local-commit.git 中生成，并导出 fix-ocr-format-error.bundle。原 worktree 的分支引用未更新，源码改动保留在原位；bundle 可供有主仓库写权限的环境导入。
