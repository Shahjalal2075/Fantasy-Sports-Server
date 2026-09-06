-- Run AFTER the migration. All three columns must be listed.
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'notification_settings'
ORDER BY ordinal_position;
