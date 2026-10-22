-- 账号软删除：不物理删除历史操作者，保留审计与审定追溯。
-- 删除动作本身必须由应用服务在事务中完成待审任务检查、会话撤销和成员禁用。

USE itembank;

ALTER TABLE accounts
  MODIFY COLUMN status ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active',
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER status,
  ADD KEY idx_accounts_status_deleted_at (status, deleted_at);
