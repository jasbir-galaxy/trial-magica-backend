ALTER TABLE "ToolInvocation" DROP CONSTRAINT "ToolInvocation_known_name";
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_known_name"
  CHECK ("name" IN ('crop_image', 'gpt_image_2', 'merge_videos', 'load_skill', 'read_skill_asset', 'propose_plan'));
