-- 迁移：账单表增加「无账单」标记
-- 仅对已存在的旧库执行一次（新库由 schema.sql 直接创建该列）：
--   npx wrangler d1 execute mycards --remote --file=migrations/0001_add_no_bill.sql
-- 本地开发库把 --remote 换成 --local。
ALTER TABLE bills ADD COLUMN no_bill INTEGER NOT NULL DEFAULT 0;
