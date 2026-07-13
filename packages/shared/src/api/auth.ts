import { z } from "zod";

export const sessionUserSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const authModeSchema = z.object({ bootstrapMode: z.boolean() });
export type AuthMode = z.infer<typeof authModeSchema>;

export const bootstrapLoginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});
export type BootstrapLoginInput = z.infer<typeof bootstrapLoginSchema>;
