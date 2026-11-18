-- Account changes used to pause schedules for review even when nothing was
-- scheduled. Clear that flag where there is nothing to review.
UPDATE accounts SET schedules_need_review = 0
WHERE schedules_need_review = 1
  AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.account_id = accounts.id AND posts.status IN ('scheduled', 'retry_waiting'));
