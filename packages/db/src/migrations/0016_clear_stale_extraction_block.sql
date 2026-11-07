-- Episodes that already passed the check gate (approved / published) can't still be blocked by a failed extraction:
-- a retried extract_facts succeeded but the block reason was only cleared on re-split. Clear the stale flag.
UPDATE episodes
SET block_reasons = array_remove(block_reasons, 'extraction_failure')
WHERE 'extraction_failure' = ANY (block_reasons)
  AND status IN ('awaiting_approval', 'approved', 'published');
