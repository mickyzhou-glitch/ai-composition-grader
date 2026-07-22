# 两位教师内测操作手册

1. 在 Mac 开启 FileVault；不要把项目或 `.data/` 放到 iCloud、Dropbox、OneDrive 或普通 Time Machine 备份中。
2. 安装依赖并构建：`npm install && npx playwright install chromium && npm run db:init && npm run build`。
3. 用 `npm run accounts -- create` 创建管理员与 `teacher01`、`teacher02`；通过单独、安全的渠道发送初始密码，首次登录后必须修改。
4. 管理员在设置页测试并保存 AI 服务。API 密钥只保存在 macOS 钥匙串。
5. 将 ngrok token 保存至钥匙串服务 `ai-composition-grader-ngrok`、账户 `tunnel-token`；在 ngrok 控制台关闭 Full Capture。固定 HTTPS 域名写入 `APP_ORIGIN` 后重新构建。
6. 安装并启动：`npm run private-beta -- install`、`npm run private-beta -- start`。检查 `http://127.0.0.1:3001/api/health`；确认无误后执行 `npm run private-beta -- tunnel`。
7. 用 `npm run private-beta -- status` 和 `npm run private-beta -- logs web` 检查服务。停止公开访问：`npm run private-beta -- stop`。
8. Mac 必须保持开机、联网且不休眠。断网或关机时教师只能看到本机服务离线，已排队任务会在恢复后继续。
9. 教师上传前必须确认：拥有处理授权、尽量遮盖姓名/学校/联系方式；图片会发送给配置的第三方 AI；本机保存最长 30 天，可提前永久删除，但不代表第三方已删除。
10. 更新版本前先停止服务，等待当前 Worker 完成，再拉取代码、构建并重新启动。管理员可停用账号、重置密码、撤销会话，并用 `npm run retention -- run` 手动清理到期作文。

ngrok 免费版可能有首次提示页和流量额度限制；先仅向 1–2 位教师发送 HTTPS 地址和各自账号，不要在群聊公开密码。
