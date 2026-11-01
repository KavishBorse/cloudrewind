ALTER TABLE incidents ADD COLUMN IF NOT EXISTS summary_mode TEXT NOT NULL DEFAULT 'summary';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS summary_window_minutes INTEGER;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS summary_window_end_ts BIGINT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS summary_causes_json TEXT NOT NULL DEFAULT '[]';
