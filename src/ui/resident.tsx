import { useState } from 'react';
import {
  BLOCK_KIND_LABEL,
  LANG_LABEL,
  currentPublication,
  hasAcked,
  latestVersion,
  liveBlocks,
  translationOf,
  visibleNoticesFor,
} from '../engine/selectors';
import type { Notice, NoticeState, Resident } from '../engine/types';
import type { Send } from './common';
import { Badge, Card } from './widgets';

/** 本地模拟居民入口：选择住户身份后查看本人有效安排 */
export function ResidentPortal({ state, send }: { state: NoticeState; send: Send }) {
  const [residentId, setResidentId] = useState(state.residents[0]?.id ?? '');
  const resident = state.residents.find((r) => r.id === residentId);

  return (
    <Card title="本地模拟居民入口（不调用真实短信，仅浏览器内演示）">
      <label>
        选择住户身份（模拟登录）：
        <select value={residentId} onChange={(e) => setResidentId(e.target.value)}>
          {state.residents.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {state.buildings.find((b) => b.id === r.buildingId)?.name} · 偏好{LANG_LABEL[r.preferredLang]}
              {r.status === 'moved_out' ? ' · 已迁出' : ''}
            </option>
          ))}
        </select>
      </label>
      {resident && <ResidentView key={resident.id} state={state} resident={resident} send={send} />}
    </Card>
  );
}

function ResidentView({ state, resident, send }: { state: NoticeState; resident: Resident; send: Send }) {
  const notices = visibleNoticesFor(state, resident);
  const myRejected = state.rejectedClicks.filter((c) => c.residentId === resident.id);
  const myAcks = state.acknowledgements.filter((a) => a.residentId === resident.id);

  if (resident.status === 'moved_out') {
    return (
      <div className="warn-box">
        该家庭已迁出，不再接收新安排。此前的 {myAcks.length} 条回复仍保留出处，可在下方追溯。
      </div>
    );
  }

  return (
    <div>
      <div className="muted small">
        仅展示「已发布且未撤回」且投递给你的安排；确认知悉绑定具体发布版本，通知更新为新版本后需重新确认。
      </div>
      {notices.length === 0 && <div className="muted">当前没有面向你的有效安排。</div>}
      {notices.map((n) => (
        <ResidentNotice key={n.id} state={state} notice={n} resident={resident} send={send} />
      ))}

      {myAcks.length > 0 && (
        <details className="history-box" open>
          <summary>我的历史回复（{myAcks.length}，含已撤回版本，保留出处）</summary>
          {myAcks.map((a) => (
            <div key={a.id} className="version-line">
              <Badge text={a.kind === 'assist' ? '协助' : '知悉'} tone={a.kind === 'assist' ? 'purple' : 'green'} />
              <span>
                {state.notices.find((n) => n.id === a.noticeId)?.title} · v{a.publicationVersion}
                {a.noticeStatusAtClick === 'withdrawn' ? '（撤回后）' : ''}
              </span>
            </div>
          ))}
        </details>
      )}
      {myRejected.length > 0 && (
        <div className="warn-box">
          <b>被拒绝的点击（不计入收悉）</b>
          {myRejected.map((c) => (
            <div key={c.id}>
              · v{c.publicationVersion}：{c.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResidentNotice({
  state,
  notice,
  resident,
  send,
}: {
  state: NoticeState;
  notice: Notice;
  resident: Resident;
  send: Send;
}) {
  const pub = currentPublication(notice)!;
  const blocks = liveBlocks(notice);
  const acked = hasAcked(state, resident.id, notice.id, pub.version);
  const [note, setNote] = useState('');
  const lang = resident.preferredLang;

  return (
    <div className="resident-notice">
      <div className="block-head">
        <b>{notice.title}</b>
        <Badge text={`发布版 v${pub.version}`} tone="green" />
        {acked && <Badge text="本版本已确认" tone="blue" />}
      </div>
      {blocks.map((b, idx) => {
        const t = translationOf(notice, b.id, lang);
        const aligned = t && t.basedOnSourceVersion === latestVersion(b) && t.text.trim();
        return (
          <div key={b.id} className="preview-block">
            <div className="muted small">
              {idx + 1}. {BLOCK_KIND_LABEL[b.kind]}
            </div>
            <div>{aligned ? t!.text : <span className="warn-text">（本语言暂缺，请联系接待台）</span>}</div>
          </div>
        );
      })}
      <div className="row-actions">
        <button
          disabled={acked}
          title={acked ? '同一版本已确认，重复点击仅记一次' : ''}
          onClick={() => void send({ type: 'ResidentAck', residentId: resident.id, noticeId: notice.id, kind: 'ack' })}
        >
          {acked ? '已确认知悉（重复点击幂等忽略）' : '我已知悉'}
        </button>
        <button
          disabled={acked}
          onClick={() =>
            void send({
              type: 'ResidentAck',
              residentId: resident.id,
              noticeId: notice.id,
              kind: 'assist',
              assistNote: note || '需要协助，请联系我',
            })
          }
        >
          我需要协助
        </button>
        <input placeholder="协助说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="muted small">提示：可在两个浏览器标签用同一住户身份同时点击，验证同一版本只记一次。</div>
    </div>
  );
}
