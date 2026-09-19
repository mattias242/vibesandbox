import type { BuildRunner } from '@vibesandbox/contracts';
export interface SpoolRunnerOptions { readonly jobsDirectory: string; readonly timeoutMs: number }
export interface SpoolWorkerOptions { readonly jobsDirectory: string; readonly templateDirectory: string; readonly signal: AbortSignal }
export function createSpoolBuildRunner(_options: SpoolRunnerOptions): BuildRunner { throw new Error('inte byggt'); }
export async function runSpoolWorker(_options: SpoolWorkerOptions): Promise<void> { throw new Error('inte byggt'); }
