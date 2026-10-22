# one tool

## 技术基线

- Next.js 14+ App Router
- Tailwind CSS
- Auth.js / NextAuth v5 Credentials
- MySQL 8.0，业务数据使用原生 SQL

## 本地启动

1. 复制 `.env.example` 为 `.env.local`，填写 MySQL 连接与 `AUTH_SECRET`。
2. 执行 `npm install`。
3. 执行 `npm run db:migrate`，按顺序应用 `database/migrations/` 中的 SQL。
4. 执行 `npm run db:seed:admin` 创建首位管理员。该命令幂等，已有启用管理员时不会重复创建。
5. 执行 `npm run dev`，访问 `http://localhost:3000`。

## 安全约束

- 首位管理员只由受控 Seed 创建，不提供公开注册，也不在 Web 进程启动时自动 Seed。
- Auth.js JWT 仅保存会话标识；服务端读写业务数据前必须用 `auth_sessions` 原生 SQL 校验会话和账号状态。
- 账号删除采用软删除，必须撤销全部会话，且不得删除最后一名启用管理员。
- 迁移文件一经在环境执行不得修改；结构变更以新的顺序 SQL 文件追加。
