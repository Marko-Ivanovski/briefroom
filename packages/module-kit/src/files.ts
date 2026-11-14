import type { Scope } from './scope.ts';

export interface FileStoreInput {
  /** Must be registered and switched on in the workspace. */
  moduleId: string;
  /** The project the file belongs to, or omitted for a workspace-level file. */
  projectId?: string;
  bytes: Buffer;
}

export interface FileRecord {
  id: string;
  workspaceId: string;
  projectId: string | null;
  moduleId: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

/** Implemented by the API. Provided globally, so module code never imports the API. */
export interface FileStore {
  /**
   * Stores an image byte for byte, plus its thumbnail and reduced copy. Throws an HTTP exception
   * for an unknown or switched-off module, an unreadable or unsupported image, or a project the
   * caller cannot see.
   */
  store(scope: Scope, input: FileStoreInput): Promise<FileRecord>;
}

export const FILE_STORE = Symbol('FILE_STORE');
