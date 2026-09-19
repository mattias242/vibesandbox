import type { BuildRunner } from '@vibesandbox/contracts';
import type { BuildLimits } from './limits.ts';
export interface DockerRunnerOptions { readonly templateDirectory: string; readonly limits: BuildLimits; readonly image: string; readonly runtime: 'runc' | 'runsc'; readonly tempDirectory?: string }
export function createDockerBuildRunner(_options: DockerRunnerOptions): BuildRunner { throw new Error('inte byggt'); }
