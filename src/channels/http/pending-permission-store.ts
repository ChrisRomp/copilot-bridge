export type AcpPermissionDecision =
  | 'allow-once'
  | 'allow-session'
  | 'allow-all-session'
  | 'allow-all'
  | 'deny';

export interface PendingPermissionRequest {
  runId: string;
  toolKind: string;
  detail?: string;
  resolve: (decision: AcpPermissionDecision) => void;
  createdAt: number;
}

export class PendingPermissionStore {
  private readonly pending = new Map<string, PendingPermissionRequest>();

  park(
    runId: string,
    request: Omit<PendingPermissionRequest, 'resolve' | 'createdAt'>,
  ): Promise<AcpPermissionDecision> {
    return new Promise<AcpPermissionDecision>((resolve) => {
      this.pending.set(runId, { ...request, runId, resolve, createdAt: Date.now() });
    });
  }

  resolve(runId: string, decision: AcpPermissionDecision): boolean {
    const entry = this.pending.get(runId);
    if (!entry) return false;
    entry.resolve(decision);
    this.pending.delete(runId);
    return true;
  }

  has(runId: string): boolean {
    return this.pending.has(runId);
  }

  get(runId: string): Omit<PendingPermissionRequest, 'resolve'> | undefined {
    const entry = this.pending.get(runId);
    if (!entry) return undefined;
    const { resolve: _, ...rest } = entry;
    return rest;
  }

  clear(runId: string): void {
    this.pending.delete(runId);
  }
}
