-- Deduplicate contacts first (keep oldest per user+phone pair),
-- then add unique constraint so bulk import upsert can use onConflict.

DELETE FROM contacts
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, phone) id
  FROM contacts
  ORDER BY user_id, phone, created_at ASC
);

ALTER TABLE contacts
  ADD CONSTRAINT contacts_user_id_phone_unique UNIQUE (user_id, phone);
