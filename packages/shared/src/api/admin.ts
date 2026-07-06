import { z } from "zod";

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["employee", "admin"]),
  locale: z.string(),
  active: z.boolean(),
  mailboxLinked: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const createUserInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(["employee", "admin"]).default("employee"),
  locale: z.string().min(2).default("es"),
  mailPassword: z.string().min(8).optional(),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

export const setRoleInputSchema = z.object({ role: z.enum(["employee", "admin"]) });
export type SetRoleInput = z.infer<typeof setRoleInputSchema>;

export const setActiveInputSchema = z.object({ active: z.boolean() });
export type SetActiveInput = z.infer<typeof setActiveInputSchema>;

export const setMailCredentialInputSchema = z.object({
  mailPassword: z.string().min(8),
});
export type SetMailCredentialInput = z.infer<typeof setMailCredentialInputSchema>;
