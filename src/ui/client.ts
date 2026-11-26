import type { Command, NoticeState, Receipt, Role } from '../engine/types';

export interface CmdResult {
  ok: boolean;
  error?: string;
  receipts: Receipt[];
  changed: boolean;
}

/**
 * UI 侧的 Worker 客户端：命令走 worker（事务内执行），
 * 状态变更通过 BroadcastChannel 在同一站点的所有标签页间同步。
 */
export class WorkerClient {
  private worker: Worker;
  private seq = 0;
  private pendingCalls = new Map<number, (msg: Record<string, unknown>) => void>();
  private bc: BroadcastChannel;
  private listeners = new Set<(s: NoticeState) => void>();

  constructor() {
    this.worker = new Worker(new URL('../worker/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { reqId: number } & Record<string, unknown>;
      const resolve = this.pendingCalls.get(m.reqId);
      if (resolve) {
        this.pendingCalls.delete(m.reqId);
        resolve(m);
      }
    };
    this.bc = new BroadcastChannel('notice-workbench');
    this.bc.onmessage = () => {
      void this.refreshState();
    };
  }

  private call(kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = ++this.seq;
    return new Promise((resolve) => {
      this.pendingCalls.set(reqId, resolve);
      this.worker.postMessage({ reqId, kind, ...payload });
    });
  }

  async cmd(cmd: Command, role: Role): Promise<CmdResult> {
    const m = await this.call('cmd', { cmd, role });
    return m.result as CmdResult;
  }

  async getState(): Promise<NoticeState> {
    const m = await this.call('getState', {});
    return m.state as NoticeState;
  }

  async refreshState(): Promise<void> {
    const s = await this.getState();
    for (const l of this.listeners) l(s);
  }

  onState(l: (s: NoticeState) => void): void {
    this.listeners.add(l);
  }
}
