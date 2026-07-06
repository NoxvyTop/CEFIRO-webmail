import type { SendEmailInput } from "@webmail/shared";
import { useReducer } from "react";
import { sendEmail, uploadAttachment } from "./api";
import { MailApiError } from "../mailbox/api";
import type { ComposerDraft } from "./reply";

export type Attachment = { blobId: string; name: string; type: string; size: number };
export type PendingUpload = { id: string; name: string; progress: number; error: boolean };

export type ComposerState = {
  draft: ComposerDraft;
  attachments: Attachment[];
  uploads: PendingUpload[];
  sending: boolean;
  sendError: string | null;
};

type Action =
  | { type: "setField"; key: keyof ComposerDraft; value: unknown }
  | { type: "addPendingUpload"; upload: PendingUpload }
  | { type: "setUploadProgress"; id: string; progress: number }
  | { type: "uploadSucceeded"; id: string; attachment: Attachment }
  | { type: "uploadFailed"; id: string }
  | { type: "removeAttachment"; blobId: string }
  | { type: "sendStart" }
  | { type: "sendFailed"; error: string }
  | { type: "sendSucceeded" };

function reducer(state: ComposerState, action: Action): ComposerState {
  switch (action.type) {
    case "setField":
      return { ...state, draft: { ...state.draft, [action.key]: action.value } };
    case "addPendingUpload":
      return { ...state, uploads: [...state.uploads, action.upload] };
    case "setUploadProgress":
      return {
        ...state,
        uploads: state.uploads.map((upload) =>
          upload.id === action.id ? { ...upload, progress: action.progress } : upload,
        ),
      };
    case "uploadSucceeded":
      return {
        ...state,
        attachments: [...state.attachments, action.attachment],
        uploads: state.uploads.filter((upload) => upload.id !== action.id),
      };
    case "uploadFailed":
      return {
        ...state,
        uploads: state.uploads.map((upload) =>
          upload.id === action.id ? { ...upload, error: true } : upload,
        ),
      };
    case "removeAttachment":
      return {
        ...state,
        attachments: state.attachments.filter((attachment) => attachment.blobId !== action.blobId),
      };
    case "sendStart":
      return { ...state, sending: true, sendError: null };
    case "sendFailed":
      return { ...state, sending: false, sendError: action.error };
    case "sendSucceeded":
      return { ...state, sending: false, sendError: null };
    default:
      return state;
  }
}

function initState(draft: ComposerDraft): ComposerState {
  return { draft, attachments: [], uploads: [], sending: false, sendError: null };
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}

export function useComposer(initial: ComposerDraft): {
  state: ComposerState;
  setField<K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K]): void;
  addFiles(files: File[]): void;
  removeAttachment(blobId: string): void;
  send(): Promise<boolean>;
} {
  const [state, dispatch] = useReducer(reducer, initial, initState);

  function setField<K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K]): void {
    dispatch({ type: "setField", key, value });
  }

  function addFiles(files: File[]): void {
    for (const file of files) {
      const id = crypto.randomUUID();
      dispatch({ type: "addPendingUpload", upload: { id, name: file.name, progress: 0, error: false } });

      uploadAttachment(file, (fraction) => {
        dispatch({ type: "setUploadProgress", id, progress: fraction });
      })
        .then((result) => {
          dispatch({
            type: "uploadSucceeded",
            id,
            attachment: { blobId: result.blobId, name: file.name, type: result.type, size: result.size },
          });
        })
        .catch(() => {
          dispatch({ type: "uploadFailed", id });
        });
    }
  }

  function removeAttachment(blobId: string): void {
    dispatch({ type: "removeAttachment", blobId });
  }

  async function send(): Promise<boolean> {
    const { draft, attachments } = state;
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      dispatch({ type: "sendFailed", error: "composer.errors.noRecipients" });
      return false;
    }

    const input: SendEmailInput = {
      identityId: draft.identityId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      textBody: htmlToPlainText(draft.bodyHtml),
      htmlBody: draft.bodyHtml,
      attachments: attachments.map((attachment) => ({
        blobId: attachment.blobId, name: attachment.name, type: attachment.type,
      })),
      inReplyTo: draft.inReplyTo,
      references: draft.references,
    };

    dispatch({ type: "sendStart" });
    try {
      await sendEmail(input);
      dispatch({ type: "sendSucceeded" });
      return true;
    } catch (err) {
      const error = err instanceof MailApiError ? `composer.errors.${err.code || "generic"}` : "composer.errors.generic";
      dispatch({ type: "sendFailed", error });
      return false;
    }
  }

  return { state, setField, addFiles, removeAttachment, send };
}
