import { z } from "zod";

export const sessionUserSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
