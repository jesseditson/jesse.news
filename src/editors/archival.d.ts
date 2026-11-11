import type { ArchivalEditorAPI, FieldValueType, FileValue } from "@archival/custom-editor-api";

export interface UploadRequest {
  filename: string;
  mime?: string;
  display_type?: "image" | "upload" | "video" | "audio";
  name?: string;
  description?: string;
  onProgress?: (fraction: number) => void;
}

// The published types predate `upload`, which the editor injects alongside `send` and `listen`.
export type EditorAPI<T extends keyof FieldValueType> = ArchivalEditorAPI<T> & {
  upload(file: File | Blob, request: UploadRequest): Promise<FileValue & { url: string }>;
};
