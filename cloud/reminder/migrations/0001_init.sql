-- 一次性邮件提醒。时间一律存 UTC 的 ISO 字符串（YYYY-MM-DDTHH:MM:SS.sssZ），可以直接按字符串比较。
CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  due_at      TEXT NOT NULL,                  -- 到点时间（UTC）
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',       -- 调用方，例如 beer
  ref         TEXT NOT NULL DEFAULT '',       -- 调用方自己的编号，例如日程条目编号
  status      TEXT NOT NULL DEFAULT 'pending' -- pending 待发 / sent 已发 / failed 失败 / cancelled 已取消
              CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,                  -- 下一次可以尝试发送的时间（UTC）；也用来认领，防止两次触发重复发
  last_error  TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX reminders_due ON reminders (status, next_try_at);
CREATE INDEX reminders_ref ON reminders (ref);
