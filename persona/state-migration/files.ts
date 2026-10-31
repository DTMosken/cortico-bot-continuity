/** Drafting and source review read the same private copy of the standing sources with the same file tools. */
import type { ToolDef } from 'cortico/core/types.ts';
import { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import { workspaceTools } from '../../base/persona/workspaceTools.ts';
import type { WorkerHost } from '../subagents/runtime.ts';

const READ_TOOLS = ['read_file', 'list_files', 'glob_files', 'grep_files'], WRITE_TOOLS = ['write_file', 'edit_file', 'append_file'];
export interface SourceReader { core: WorkerHost; tools: ToolDef[] }

export function sourceListing(sources: Record<string, string>): string {
  return Object.entries(sources).map(([path, text]) => `sources/${path} (${text.length} characters)`).join('\n');
}
export function writeMigrationSources(memory: GitWorkspaceMemory, sources: Record<string, string>): void {
  for (const [path, text] of Object.entries(sources)) memory.writeFileAtomic('sources/' + path, text);
  memory.writeFileAtomic('reference/sources.md', sourceListing(sources));
}
/** Without a writable path only the read tools are returned, and every write is refused. */
export function migrationFileTools(memory: GitWorkspaceMemory, readChars: number, writable?: { path: string; denied: string }): ToolDef[] {
  return workspaceTools({ memory, prefixResidentFiles: () => [], wholeReadFallbackChars: () => readChars,
    readOverride: () => null,
    writeGuard: (_op, path) => writable && path === writable.path ? null : writable?.denied ?? 'Source review is read-only.',
  }).filter(tool => READ_TOOLS.includes(tool.name) || !!writable && WRITE_TOOLS.includes(tool.name));
}
