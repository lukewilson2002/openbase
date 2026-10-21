-- OpenBase schema v15: each person picks the app's accent colour (PATCH /api/auth/me {accent}),
-- one of the palette's hues. NULL = the default, blue.
ALTER TABLE users ADD COLUMN accent TEXT;
