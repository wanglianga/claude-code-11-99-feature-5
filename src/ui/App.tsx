import { useEffect, useMemo, useState } from 'react';
import { fmtClock } from '../engine/format';
import type { Command, NoticeState, Role } from '../engine/types';
import { WorkerClient } from './client';
import type { DraftCommand, Send } from './common';
import { MoveOutPanel, AckPanel, DeliveryPanel, FullPreview, PublishPanel } from './duty';
import { NoticeList, SourceEditor } from './receptionist';
import { ResidentPortal } from './resident';
import { TranslatorWorkbench } from './translator';
import { InvariantsPanel, ReceiptsPanel } from './widgets';

const ROLES: Role[] = ['receptionist', 'translator', 'duty', 'resident'];
const ROLE_NAME: Record<Role, string> = {
  receptionist: '接待员',
  translator: '翻译志愿者',
  duty: '值班负责人',
  resident: '住户（居民入口）',
};

type DutyTab = 'preview' | 'publish' | 'ack' | 'delivery';

export default function App() {
  const [client] = useState(() => new WorkerClient());
  const [state, setState] = useState<NoticeState | null>(null);
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('notice-role') as Role | null;
    return saved && ROLES.includes(saved) ? saved : 'receptionist';
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [dutyTab, setDutyTab] = useState<DutyTab>('preview');
  const [error, setError] = useState<string | null>(null);
  const [tabId] = useState(() => Math.random().toString(36).slice(2, 6).toUpperCase());

  useEffect(() => {
    client.onState(setState);
    void client.refreshState();
  }, [client]);

  const send: Send = useMemo(
    () => async (draft: DraftCommand) => {
      const cmd = { ...draft, commandId: crypto.randomUUID() } as Command;
      const r = await client.cmd(cmd, role);
      if (!r.ok && r.error) setError(r.error);
      else setError(null);
      await client.refreshState();
      return r.ok;
    },
    [client, role],
  );

  if (!state) return <div className="loading">正在加载本地数据…</div>;

  const selected =
    state.notices.find((n) => n.id === selectedId) ?? state.notices[state.notices.length - 1] ?? undefined;
  const advance = (ms: number) =>
    void send({ type: 'AdvanceClock', toVirtual: state.virtualNow + ms });

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">多语言通知发布与收悉工作台</div>
        <label className="role-select">
          角色入口：
          <select
            value={role}
            onChange={(e) => {
              const r = e.target.value as Role;
              setRole(r);
              localStorage.setItem('notice-role', r);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_NAME[r]}
              </option>
            ))}
          </select>
        </label>
        <span className="clock">演示时间：{fmtClock(state.virtualNow)}</span>
        <button onClick={() => void advance(15 * 60_000)}>+15分钟</button>
        <button onClick={() => void advance(3600_000)}>+1小时</button>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('重置为初始演示场景？')) void send({ type: 'ResetDemo' });
          }}
        >
          重置演示数据
        </button>
        <span className="tab-badge" title="同一站点多标签页共享 IndexedDB，操作实时同步">
          标签页 #{tabId} · 多标签已同步
        </span>
      </header>

      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          ✗ {error}（点击关闭）
        </div>
      )}

      {role === 'resident' ? (
        <div className="single-col">
          <ResidentPortal state={state} send={send} />
          <ReceiptsPanel receipts={state.receipts} />
        </div>
      ) : (
        <div className="layout">
          <section className="col col-left">
            <NoticeList state={state} selectedId={selected?.id} onSelect={setSelectedId} send={send} role={role} />
            {(role === 'receptionist' || role === 'duty') && <MoveOutPanel state={state} send={send} />}
          </section>

          <section className="col col-main">
            {!selected ? (
              <div className="muted">请选择或新建一条通知</div>
            ) : (
              <>
                <div className="notice-title-line">
                  <h2>{selected.title}</h2>
                </div>
                {role === 'receptionist' && <SourceEditor state={state} notice={selected} send={send} />}
                {role === 'translator' && <TranslatorWorkbench state={state} notice={selected} send={send} />}
                {role === 'duty' && (
                  <>
                    <div className="tab-row">
                      {(['preview', 'publish', 'ack', 'delivery'] as DutyTab[]).map((t) => (
                        <button
                          key={t}
                          className={`tab-btn ${dutyTab === t ? 'active' : ''}`}
                          onClick={() => setDutyTab(t)}
                        >
                          {t === 'preview' ? '完整预览' : t === 'publish' ? '发布/撤回' : t === 'ack' ? '收悉缺口与协助' : '模拟投递'}
                        </button>
                      ))}
                    </div>
                    {dutyTab === 'preview' && <FullPreview state={state} notice={selected} />}
                    {dutyTab === 'publish' && <PublishPanel state={state} notice={selected} send={send} />}
                    {dutyTab === 'ack' && <AckPanel state={state} notice={selected} />}
                    {dutyTab === 'delivery' && <DeliveryPanel state={state} notice={selected} />}
                  </>
                )}
              </>
            )}
          </section>

          <section className="col col-right">
            <InvariantsPanel state={state} />
            <ReceiptsPanel receipts={state.receipts} />
          </section>
        </div>
      )}
    </div>
  );
}
