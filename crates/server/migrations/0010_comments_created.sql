-- OpenBase schema v10: the activity feed (`GET /api/history`) reads the newest comments across
-- tables, which `comments_record` (by record) cannot serve in order.
CREATE INDEX comments_created ON comments(created_at, id);
