-- Item #5: Auto-generated launch card image (1200x630 OG)
--
-- Stores the Vercel Blob URL of the agent PFP we generate at tokenize time
-- so the OG image route at /launches/[addr]/opengraph-image can render the
-- agent's face in the share-card preview without a runtime SSH or Bankr
-- metadata fetch. Path A (dashboard) populates this from the same `image`
-- field it already sends to Bankr's deploy API. Path B (chat-launch) leaves
-- it NULL and the OG card falls back to ticker-initial styling.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS bankr_token_image_url TEXT;

COMMENT ON COLUMN instaclaw_vms.bankr_token_image_url IS
  'Vercel Blob URL of the agent PFP used as token logo + share-card image. NULL for chat-launched tokens (Path B) where we never had the image client-side.';
