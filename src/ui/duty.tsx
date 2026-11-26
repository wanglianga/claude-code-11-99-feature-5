import {
  BLOCK_KIND_LABEL,
  LANG_LABEL,
  currentPublication,
  currentSourceText,
  isPublishedNow,
  latestVersion,
  liveBlocks,
  publicationAckStats,
  releaseCheck,
  translationOf,
} from '../engine/selectors';
import type { Notice, NoticeState } from '../engine/types';
import type { Send } from './common';
import { targetName } from './receptionist';
import { Badge, Card } from './widgets';

/** 发布完整性 + 发布/撤回 */
export function PublishPanel({ state, notice, send }: { state: NoticeState; notice: Notice; send: Send }) {
  const check = releaseCheck(state, notice);
  const pub = currentPublication(notice);
  const published = isPublishedNow(notice);
  return (
    <Card
      title={
        <>
          发布与完整性
          {published ? <Badge text={`发布中 v${pub!.version}`} tone="green" /> : <Badge text={notice.status === 'withdrawn' ? '已撤回' : '草稿'} tone="gray" />}
        </>
      }
    >
      <div className="muted small">
        两种审阅路径都只能在「全部必需语言 × 全部区块」译文齐备且审阅有效时发布；缺译文本不能补成已批准。
      </div>
      <div className="lang-progress">
        {state.languages.map((l) => {
          const p = check.perLang[l];
          const allOk = p.translated === p.total && p.approved === p.total;
          return (
            <div key={l} className={`lang-prog ${allOk ? 'prog-ok' : 'prog-bad'}`}>
              <b>{LANG_LABEL[l]}</b>
              <span>
                译文 {p.translated}/{p.total} · 有效审阅 {p.approved}/{p.total}
              </span>
            </div>
          );
        })}
      </div>
      {check.issues.length > 0 && (
        <div className="warn-box">
          <b>发布缺口（{check.issues.length}）</b>
          {check.issues.map((i, idx) => (
            <div key={idx}>· [{i.scope}] {i.detail}</div>
          ))}
        </div>
      )}
      <div className="row-actions">
        {!published ? (
          <button disabled={!check.canPublish} title={check.canPublish ? '' : '存在发布缺口'} onClick={() => void send({ type: 'Publish', noticeId: notice.id })}>
            检查组合并发布
          </button>
        ) : (
          <button
            className="danger"
            onClick={async () => {
              if (window.confirm('撤回该发布版？居民入口将不再展示，撤回后的确认会被拒绝。'))
                await send({ type: 'Withdraw', noticeId: notice.id });
            }}
          >
            撤回当前发布版
          </button>
        )}
      </div>
      {published && (
        <div className="muted small">
          投递对象 {pub!.recipientResidentIds.length} 人（发布时在住名单已固定）。发布数量不等于实际收悉人数，请看下方收悉缺口。
        </div>
      )}
    </Card>
  );
}

/** 完整预览：三语言 × 区块，标注源文版本与引用 */
export function FullPreview({ state, notice }: { state: NoticeState; notice: Notice }) {
  const blocks = liveBlocks(notice);
  return (
    <Card title="完整预览（住户可见内容 · 三语言）">
      <div className="muted small">
        投递：{targetName(state, notice)}（{notice.targetType === 'building' ? '楼栋' : '家庭'}）
      </div>
      {state.languages.map((lang) => (
        <div key={lang} className="preview-lang">
          <div className="preview-lang-head">{LANG_LABEL[lang]}</div>
          {blocks.map((b, idx) => {
            const t = translationOf(notice, b.id, lang);
            const aligned = t?.basedOnSourceVersion === latestVersion(b) && t?.text.trim();
            return (
              <div key={b.id} className={`preview-block ${aligned ? '' : 'preview-missing'}`}>
                <div className="muted small">
                  {idx + 1}. {BLOCK_KIND_LABEL[b.kind]}（源文 v{latestVersion(b)}
                  {t ? `，译文基于 v${t.basedOnSourceVersion}` : '，无译文'}）
                </div>
                <div>{aligned ? t!.text : <span className="warn-text">⚠ 缺译或译文过期，不能发布</span>}</div>
              </div>
            );
          })}
        </div>
      ))}
      <details>
        <summary>查看源文与引用</summary>
        {blocks.map((b, idx) => (
          <div key={b.id} className="version-line">
            <Badge text={`v${latestVersion(b)}`} tone="blue" />
            <span>
              {idx + 1}. {BLOCK_KIND_LABEL[b.kind]}：{currentSourceText(b)}
            </span>
          </div>
        ))}
      </details>
    </Card>
  );
}

/** 收悉缺口与协助待办 */
export function AckPanel({ state, notice }: { state: NoticeState; notice: Notice }) {
  const pubs = [...notice.publications].sort((a, b) => b.version - a.version);
  return (
    <Card title="收悉缺口与协助待办">
      {pubs.length === 0 && <div className="muted">（尚未发布，无收悉数据）</div>}
      {pubs.map((pub) => {
        const stats = publicationAckStats(state, notice, pub);
        const acks = state.acknowledgements.filter(
          (a) => a.noticeId === notice.id && a.publicationVersion === pub.version,
        );
        const assists = acks.filter((a) => a.kind === 'assist');
        return (
          <div key={pub.version} className="pub-box">
            <div className="block-head">
              <b>发布版 v{pub.version}</b>
              {pub.withdrawnAt ? <Badge text="已撤回" tone="orange" /> : <Badge text="发布中" tone="green" />}
              <Badge text={`审阅：${pub.mode === 'whole' ? '整份' : '区块'}`} tone="blue" />
            </div>
            <div className="ack-metrics">
              <span>投递 {stats.recipients} 人</span>
              <span className="c-present">已收悉/回应 {stats.ackedCount} 人</span>
              <span className="c-gap">收悉缺口 {stats.gapCount} 人</span>
              <span className="c-assist">协助待办 {stats.assistCount} 条</span>
            </div>
            <div className="muted small">
              缺口住户：
              {stats.gapResidents.length ? stats.gapResidents.map((r) => r.name).join('、') : '（无，已全覆盖）'}
            </div>
            {assists.length > 0 && (
              <div className="assist-list">
                {assists.map((a) => {
                  const r = state.residents.find((x) => x.id === a.residentId);
                  return (
                    <div key={a.id} className="assist-item">
                      <Badge text="协助" tone="purple" />
                      <b>{r?.name}</b>
                      <span className="muted">{a.assistNote}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <details>
              <summary>本版本全部回复（{acks.length}）</summary>
              {acks.map((a) => {
                const r = state.residents.find((x) => x.id === a.residentId);
                return (
                  <div key={a.id} className="version-line">
                    <Badge text={a.kind === 'assist' ? '协助' : '知悉'} tone={a.kind === 'assist' ? 'purple' : 'green'} />
                    <span>
                      {r?.name} · {a.residentStatusAtClick === 'moved_out' ? '（点击时已迁出，保留出处）' : ''}
                    </span>
                  </div>
                );
              })}
            </details>
          </div>
        );
      })}
      {state.rejectedClicks.filter((c) => c.noticeId === notice.id).length > 0 && (
        <div className="warn-box">
          <b>被拒绝的确认（不计入收悉）</b>
          {state.rejectedClicks
            .filter((c) => c.noticeId === notice.id)
            .map((c) => {
              const r = state.residents.find((x) => x.id === c.residentId);
              return (
                <div key={c.id}>
                  · {r?.name} 对 v{c.publicationVersion} 的确认被拒：{c.reason}
                </div>
              );
            })}
        </div>
      )}
    </Card>
  );
}

/** 本地模拟投递记录 */
export function DeliveryPanel({ state, notice }: { state: NoticeState; notice: Notice }) {
  const records = state.deliveries.filter((d) => d.noticeId === notice.id);
  return (
    <Card title={`本地模拟投递（${records.length}，不发真实短信）`}>
      {records.length === 0 && <div className="muted">（无投递记录，发布后由模拟适配器入队）</div>}
      {records.slice(-20).map((d) => {
        const r = state.residents.find((x) => x.id === d.residentId);
        return (
          <div key={d.id} className="version-line">
            <Badge text={d.status === 'delivered' ? '已送达' : '排队中'} tone={d.status === 'delivered' ? 'green' : 'orange'} />
            <span>
              {r?.name} · {LANG_LABEL[d.lang]} · v{d.publicationVersion} · {d.channel}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

/** 家庭迁出（接待员/值班负责人） */
export function MoveOutPanel({ state, send }: { state: NoticeState; send: Send }) {
  return (
    <Card title="家庭迁出（迁出后不再接收新安排，历史回复保留）">
      {state.families.map((f) => {
        const members = state.residents.filter((r) => r.familyId === f.id);
        const allOut = members.every((m) => m.status === 'moved_out');
        return (
          <div key={f.id} className="version-line">
            <span>
              <b>{f.name}</b>（{state.buildings.find((b) => b.id === f.buildingId)?.name}）·{' '}
              {members.map((m) => `${m.name}${m.status === 'moved_out' ? '(迁出)' : ''}`).join('、')}
            </span>
            <button className="mini" disabled={allOut} onClick={() => void send({ type: 'MoveOutFamily', familyId: f.id })}>
              {allOut ? '已迁出' : '办理迁出'}
            </button>
          </div>
        );
      })}
    </Card>
  );
}
