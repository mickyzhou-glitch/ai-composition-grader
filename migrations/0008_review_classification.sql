ALTER TABLE reviews ADD COLUMN class_name TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS reviews_owner_class ON reviews(owner_id, class_name);
