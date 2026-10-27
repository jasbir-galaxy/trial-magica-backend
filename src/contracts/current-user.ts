import { z } from "zod";

export const CURRENT_USER_PATH = "/api/app/v1/me";
export const CurrentUserSchema = z.object({ userId: z.string().min(1) });
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
