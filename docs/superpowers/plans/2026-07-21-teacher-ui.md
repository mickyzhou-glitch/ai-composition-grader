# 教师端 UI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用 Next.js App Router 构建作文批改助手的教师端首页、新建、设置与复核编辑流程，并提供只读取当前批改图片的安全文件路由。

**架构：** 页面保持为薄 Client Component，通过 `apiFetch` 解析统一响应信封。可复用组件承担状态、异步按钮、批注与报告编辑；文件读取在服务层先核对数据库白名单路径，再交给既有安全文件存储读取。

**技术栈：** Next.js 16 App Router、React 19、TypeScript、Vitest、React Testing Library、原生 CSS。

---

### 任务 1：共享 API 与首页、设置

**文件：**
- 创建：`app/components/AppHeader.tsx`、`app/components/StatusBadge.tsx`、`app/components/AsyncButton.tsx`、`app/components/ErrorBanner.tsx`、`app/lib/api.ts`
- 修改：`app/page.tsx`、`app/settings/page.tsx`、`app/globals.css`
- 测试：`app/page.test.tsx`、`app/settings/page.test.tsx`

- [ ] 先写 fetch 加载、空状态、删除确认、密钥不回显和测试失败用例。
- [ ] 运行 `npm test -- app/page.test.tsx app/settings/page.test.tsx`，确认因页面行为缺失失败。
- [ ] 实现最小页面与统一信封解析，键盘操作使用原生按钮/链接/输入控件。
- [ ] 重跑定向测试，预期全部通过。

### 任务 2：新建三步流程

**文件：**
- 创建：`app/new/page.tsx`
- 测试：`app/new/page.test.tsx`

- [ ] 先写预设、自定义必填校验、三张图顺序/旋转/裁剪与先建记录后上传的测试。
- [ ] 运行 `npm test -- app/new/page.test.tsx`，确认失败原因是页面缺失。
- [ ] 实现预设配置、图片本地预览与变换状态、POST review 后 multipart 上传，上传失败保留状态以供重试。
- [ ] 重跑定向测试，预期全部通过。

### 任务 3：复核编辑与报告

**文件：**
- 创建：`app/components/PhotoAnnotationEditor.tsx`、`app/components/ReportEditor.tsx`、`app/components/ScoreCard.tsx`、`app/reviews/[id]/page.tsx`
- 测试：`app/components/PhotoAnnotationEditor.test.tsx`、`app/components/ReportEditor.test.tsx`、`app/reviews/[id]/page.test.tsx`

- [ ] 先写坐标限制、新增/编辑/删除、分数边界、报告保存和分析冲突用例。
- [ ] 运行上述测试，确认因组件/行为缺失而失败。
- [ ] 实现图片 tabs、SVG marker、按 y 排序批注、报告字段、确定性总分等级和离开提醒。
- [ ] 重跑定向测试，预期全部通过。

### 任务 4：安全文件读取

**文件：**
- 创建：`app/api/reviews/[id]/files/route.ts`
- 修改：`src/services/review-service.ts`、`src/api/handlers.ts`
- 测试：`src/api/files-route.test.ts`

- [ ] 先写当前记录白名单图片成功、未登记路径 404、越界路径拒绝和 Content-Type 用例。
- [ ] 运行 `npm test -- src/api/files-route.test.ts`，确认文件读取处理器缺失。
- [ ] 在 ReviewService 中严格匹配 `originalPath`/`annotationPath`/`aiPath`，仅允许 `images/<单文件名>`，由文件存储读取并按扩展名返回 MIME。
- [ ] 重跑定向测试，预期全部通过。

### 任务 5：整体视觉与验证

**文件：**
- 修改：`app/globals.css`、`app/layout.tsx`

- [ ] 将纸张色、教师红、低饱和状态色、12px 圆角与响应式双栏落实到 CSS，并补齐焦点样式与 aria 标签。
- [ ] 运行 `npm test`，预期 0 个失败。
- [ ] 运行 `npm run lint`，预期 0 个错误。
- [ ] 运行 `npm run build`，预期退出码 0。
- [ ] 检查 `git diff --check` 和 `git status --short`，提交任务 4/6。
