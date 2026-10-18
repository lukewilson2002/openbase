/** Uploads for rich text in a record: files go to the project of the table being edited, like attachment cells. */
import { useCallback } from "react";
import { attachmentsApi } from "@/api/records";
import type { AttachmentRef } from "@/api/types";
import { useEditorEnv } from "./env";

export function useProjectUpload(): (file: File) => Promise<AttachmentRef> {
  const { baseId } = useEditorEnv();
  return useCallback((file: File) => attachmentsApi.upload(baseId, file), [baseId]);
}
