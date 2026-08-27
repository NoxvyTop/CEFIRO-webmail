import type { ContactsRepo } from "../../infra/repos/contacts";
import type { SessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";

export type ContactsDeps = {
  sessions: SessionStore;
  contacts: ContactsRepo;
};

export type ContactsVariables = AuthVariables;
