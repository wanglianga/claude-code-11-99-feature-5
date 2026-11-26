import { applyCommand } from '../engine/engine';
import type { CmdOutcome, Command, Role } from '../engine/types';
import { readState, transact } from './store';

/**
 * WebWorker：所有写操作都经过「IndexedDB 事务 + 领域引擎」管线，
 * 计算与持久化均在本地完成，不依赖任何后端，也不调用真实短信服务。
 *
 * 通知投递由本地模拟适配器承担：发布时入队 DeliveryRecord（带真实时间戳的
 * 应送达时刻），worker 内定时清扫在到期后于新事务中标记「送达」。刷新或换
 * 标签页后，任一 worker 启动即补结算。
 */

interface WorkerScope {
  postMessage: (msg: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = self as unknown as WorkerScope;

const bc = new BroadcastChannel('notice-workbench');

interface CmdResultView {
  ok: boolean;
  error?: string;
  receipts: CmdOutcome['receipts'];
  changed: boolean;
}

async function runInTx(cmd: Command, role: Role): Promise<CmdOutcome> {
  const realNow = Date.now();
  return transact((s) => {
    const r = applyCommand(s, cmd, { role, realNow });
    return r.changed ? { state: r.state, out: r } : { out: r };
  });
}

async function handleCmd(cmd: Command, role: Role): Promise<CmdResultView> {
  const out = await runInTx(cmd, role);
  if (out.changed) bc.postMessage({ type: 'invalidate', version: out.state.version });
  return { ok: !out.error, error: out.error, receipts: out.receipts, changed: out.changed };
}

/** 本地模拟适配器：结算到期的排队投递（仅本地状态，不发真实短信） */
async function sweep() {
  try {
    const realNow = Date.now();
    const out = await transact((s) => {
      const r = applyCommand(
        s,
        { type: 'SweepDeliveries', commandId: `sweep-${realNow}` },
        { role: 'duty', realNow },
      );
      return r.changed ? { state: r.state, out: r } : { out: r };
    });
    if (out.changed) bc.postMessage({ type: 'invalidate', version: out.state.version });
  } catch {
    // 清扫失败不影响主流程，下一轮重试
  }
}

ctx.onmessage = async (e: MessageEvent) => {
  const data = e.data as { reqId: number; kind: string; cmd?: Command; role?: Role };
  const { reqId, kind } = data;
  try {
    if (kind === 'cmd') {
      const result = await handleCmd(data.cmd as Command, data.role as Role);
      ctx.postMessage({ reqId, result });
    } else if (kind === 'getState') {
      const state = await readState();
      ctx.postMessage({ reqId, state });
    } else {
      ctx.postMessage({ reqId, result: { ok: false, error: `未知请求: ${kind}`, receipts: [], changed: false } });
    }
  } catch (err) {
    ctx.postMessage({
      reqId,
      result: { ok: false, error: err instanceof Error ? err.message : String(err), receipts: [], changed: false },
    });
  }
};

// 启动即补结算（覆盖“中途刷新”场景），之后周期性清扫
void sweep();
setInterval(() => {
  void sweep();
}, 600);
