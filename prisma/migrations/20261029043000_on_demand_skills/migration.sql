-- CreateTable
CREATE TABLE "SkillVersion" (
    "contentHash" VARCHAR(64) NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(320) NOT NULL,
    "body" TEXT NOT NULL,
    "assets" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("contentHash")
);

-- CreateTable
CREATE TABLE "RunSkill" (
    "runId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "versionHash" VARCHAR(64) NOT NULL,
    "loadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("runId","name")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_contentHash_name_key" ON "SkillVersion"("contentHash", "name");

-- CreateIndex
CREATE INDEX "RunSkill_versionHash_name_idx" ON "RunSkill"("versionHash", "name");

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_versionHash_name_fkey" FOREIGN KEY ("versionHash", "name") REFERENCES "SkillVersion"("contentHash", "name") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Additive tool names; existing media rows and accounting stay unchanged.
ALTER TABLE "ToolInvocation" DROP CONSTRAINT "ToolInvocation_known_name";
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_known_name"
  CHECK ("name" IN ('crop_image', 'gpt_image_2', 'merge_videos', 'load_skill', 'read_skill_asset'));
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_valid_bundle"
  CHECK ("formatVersion" = 1 AND "contentHash" ~ '^[a-f0-9]{64}$'
    AND octet_length("body") BETWEEN 1 AND 16000 AND jsonb_typeof("assets") = 'array');
