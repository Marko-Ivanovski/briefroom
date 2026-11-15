import type { Scope } from './scope.ts';
import type { UploadReader } from './upload.ts';

export interface FileStoreInput {
  /** Leave out: the store always uses the module's own id and refuses any other one. */
  moduleId?: string;
  /** The project the file belongs to, or omitted for a workspace-level file. */
  projectId?: string;
  /** Pass the upload reader as it is: the store reads the body only after its own checks pass. */
  bytes: Buffer | UploadReader;
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

/** What a module injects. Bound to the module's own id by `provideModuleServices` (R140), and provided by both the API and the worker. */
export interface FileStore {
  /**
   * Stores an image byte for byte, plus its thumbnail and reduced copy. Throws an HTTP exception
   * for a switched-off module, an unreadable or unsupported image, or a project the caller cannot
   * see.
   */
  store(scope: Scope, input: FileStoreInput): Promise<FileRecord>;
  /**
   * Removes one of the module's own files. A file the caller cannot see, one that is gone, and one
   * that belongs to another module are all a 404. The row goes in a transaction and the stored
   * copies right after it, so a failure on disk leaves them for the core's cleanup job.
   */
  remove(scope: Scope, fileId: string): Promise<void>;
}

export const FILE_STORE = Symbol('FILE_STORE');
