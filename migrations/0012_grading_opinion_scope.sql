-- 区分长期规则和仅当前文章。旧意见无法分辨属于哪一框，默认只留在当前文章，不自动变成长期规则。
ALTER TABLE grading_opinions ADD COLUMN scope TEXT NOT NULL DEFAULT 'essay';
