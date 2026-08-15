import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';
import type { ProcessExecutionWorkspaceTask } from './process-execution-workspace.js';

/**
 * Module-owned semantic preparation for one materialized workspace template.
 *
 * Runtime materializers own paths, pinned bytes and filesystem writes. A
 * Process Module may only transform the contents of one declared template
 * using its frozen task input. This keeps module semantics out of the generic
 * workspace runtime while allowing weak-model call files to be machine-filled.
 */
export interface ProcessWorkspaceTemplatePreparationContext {
  readonly module: ProcessModuleDefinition;
  readonly profile: ExecutionProfileDefinition;
  readonly task: ProcessExecutionWorkspaceTask;
  readonly projectId: number;
  readonly epicId: number;
  readonly nodeId: string | null;
  readonly declaredPath: string;
  readonly materializedName: string;
  readonly sourceContent: string;
  readonly currentContent: string;
  /**
   * True only when this execution did not inherit or already own a semantic
   * draft. Preparers must not overwrite model-authored recovery work when it
   * is false.
   */
  readonly isFresh: boolean;
}

export type ProcessWorkspaceTemplatePreparer = (
  context: ProcessWorkspaceTemplatePreparationContext,
) => string | null;

/** Composition-root registry. Runtime looks up by immutable module reference. */
export type ProcessWorkspaceTemplatePreparerRegistry =
  ReadonlyMap<string, ProcessWorkspaceTemplatePreparer>;
