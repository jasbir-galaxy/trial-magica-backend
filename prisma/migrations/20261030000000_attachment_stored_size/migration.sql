ALTER TABLE "Attachment" ADD COLUMN "storedSize" INTEGER;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_storedSize_check" CHECK ("storedSize" IS NULL OR ("storedSize" > 0 AND "storedSize" <= 536870912));
