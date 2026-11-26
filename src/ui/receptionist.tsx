import { useState } from 'react';
import {
  BLOCK_KIND_LABEL,
  LANG_LABEL,
  blockById,
  blocksWithBrokenRefs,
  brokenRefs,
  currentPublication,
  currentSourceText,
  incomingRefs,
  isPublishedNow,
  latestVersion,
  liveBlocks,
  outgoingRefs,
  releaseCheck,
} from '../engine/selectors';
import type { BlockKind, Notice, NoticeState, Role } from '../engine/types';
import type { Send } from './common';
import { Badge, Card } from './widgets';

const MODE_BADGE: Record<Notice['reviewMode'], string> = { whole: '整份审阅', block: '区块审阅' };
const STATUS_BADGE: Record<Notice['status'], { text: string; tone: string }> = {
  draft: { text: '草稿', tone: 'gray' },
  published: { text: '发布中', tone: 'green' },
  withdrawn: { text: '已撤回', tone: 'orange' },
};

export function targetName(state: NoticeState, n: Notice): string {
  if (n.targetType === 'building') return state.buildings.find((b) => b.id === n.targetId)?.name ?? n.targetId;
  return state.families.find((f) => f.id === n.targetId)?.name ?? n.targetId;
}

export function NoticeList({
  state,
  selectedId,
  onSelect,
  send,
  role,
}: {
  state: NoticeState;
  selectedId?: string;
  onSelect: (id: string) => void;
  send: Send;
  role: Role;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <Card title={`通知（${state.notices.length}）`}>
      {state.notices.map((n) => {
        const st = STATUS_BADGE[n.status];
        const check = releaseCheck(state, n);
        return (
          <div
            key={n.id}
            className={`notice-item ${selectedId === n.id ? 'selected' : ''}`}
            onClick={() => onSelect(n.id)}
          >
            <div className="notice-item-head">
              <b>{n.title}</b>
              <Badge text={MODE_BADGE[n.reviewMode]} tone="blue" />
              <Badge text={st.text} tone={st.tone} />
            </div>
            <div className="muted">
              投递：{n.targetType === 'building' ? '楼栋' : '家庭'} · {targetName(state, n)}
              {currentPublication(n) && ` · 当前发布版 v${currentPublication(n)!.version}`}
            </div>
            <div className="muted">
              {isPublishedNow(n)
                ? '发布中（修订须先撤回）'
                : check.canPublish
                  ? '已具备发布条件'
                  : `发布缺口 ${check.issues.length} 项`}
            </div>
          </div>
        );
      })}
      {role === 'receptionist' && (
        <div className="row-actions">
          <button onClick={() => setCreating((v) => !v)}>{creating ? '收起新建' : '＋ 新建通知'}</button>
        </div>
      )}
      {creating && <CreateNoticeForm state={state} send={send} onCreated={(id) => { setCreating(false); onSelect(id); }} />}
    </Card>
  );
}

function CreateNoticeForm({
  state,
  send,
  onCreated,
}: {
  state: NoticeState;
  send: Send;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [targetType, setTargetType] = useState<'building' | 'family'>('building');
  const [targetId, setTargetId] = useState(state.buildings[0]?.id ?? '');
  const [texts, setTexts] = useState<string[]>(['', '', '']);
  const [kinds, setKinds] = useState<BlockKind[]>(['subject', 'time_place', 'action']);
  const [refOn, setRefOn] = useState(true);

  const setText = (i: number, v: string) => setTexts((arr) => arr.map((x, j) => (j === i ? v : x)));

  const submit = async () => {
    const blocks = kinds.map((kind, i) => ({ kind, text: texts[i] })).filter((b) => b.text.trim());
    if (!title.trim() || blocks.length === 0) return;
    // 初始引用按下标：区块3（下标2）引用区块2（下标1）
    const refIndices: [number, number][] = refOn && blocks.length >= 3 ? [[2, 1]] : [];
    const ok = await send({
      type: 'CreateNotice',
      input: { title, targetType, targetId, blocks, refIndices },
    });
    if (ok) {
      setTitle('');
      setTexts(['', '', '']);
      // 选中最新通知
      onCreated('latest');
    }
  };

  return (
    <div className="form-box">
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：餐点配送安排通知" />
      </label>
      <label>
        投递对象
        <select
          value={`${targetType}:${targetId}`}
          onChange={(e) => {
            const [t, id] = e.target.value.split(':');
            setTargetType(t as 'building' | 'family');
            setTargetId(id);
          }}
        >
          {state.buildings.map((b) => (
            <option key={b.id} value={`building:${b.id}`}>楼栋 · {b.name}</option>
          ))}
          {state.families.map((f) => (
            <option key={f.id} value={`family:${f.id}`}>家庭 · {f.name}</option>
          ))}
        </select>
      </label>
      {kinds.map((kind, i) => (
        <label key={i}>
          区块{i + 1}（{BLOCK_KIND_LABEL[kind]}）
          <textarea value={texts[i]} onChange={(e) => setText(i, e.target.value)} rows={2} />
        </label>
      ))}
      <label className="inline">
        <input type="checkbox" checked={refOn} onChange={(e) => setRefOn(e.target.checked)} />
        登记引用：区块3（行动说明）引用区块2（时间地点）
      </label>
      <div className="row-actions">
        <button disabled={!title.trim() || texts.every((t) => !t.trim())} onClick={() => void submit()}>
          创建（默认区块审阅）
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 源文编辑（接待员）
// ---------------------------------------------------------------------------

export function SourceEditor({ state, notice, send }: { state: NoticeState; notice: Notice; send: Send }) {
  const blocks = liveBlocks(notice);
  const broken = blocksWithBrokenRefs(notice);
  const locked = isPublishedNow(notice);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const move = async (blockId: string, delta: number) => {
    const ids = blocks.map((b) => b.id);
    const i = ids.indexOf(blockId);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await send({ type: 'ReorderBlocks', noticeId: notice.id, orderedBlockIds: ids });
  };

  return (
    <Card
      title={
        <>
          源文与区块结构
          <Badge text={locked ? '发布中·只读（撤回后可改）' : '可编辑'} tone={locked ? 'orange' : 'green'} />
        </>
      }
    >
      <div className="muted small">
        每次修订生成递增源文版本并保留历史；译文绑定具体源文版本，不会自动跟随。引用关系（如行动说明→时间地点）显式登记。
      </div>

      <div className="row-actions">
        <button
          disabled={locked}
          onClick={() =>
            void send({ type: 'SwitchReviewMode', noticeId: notice.id, mode: notice.reviewMode === 'whole' ? 'block' : 'whole' })
          }
        >
          切换为{notice.reviewMode === 'whole' ? '区块审阅' : '整份审阅'}（清空审阅结论）
        </button>
      </div>

      {brokenRefs(notice).length > 0 && (
        <div className="warn-box">
          ⚠ 待修复引用：
          {brokenRefs(notice).map((r) => (
            <div key={`${r.fromBlockId}>${r.toBlockId}`}>
              「{blockById(notice, r.fromBlockId) ? BLOCK_KIND_LABEL[blockById(notice, r.fromBlockId)!.kind] : r.fromBlockId}」
              引用的区块已删除/不存在 —— 发布前必须改指有效区块或移除引用，不能发布残缺指示
            </div>
          ))}
          <RefEditor state={state} notice={notice} send={send} />
        </div>
      )}

      {blocks.map((b, idx) => {
        const v = latestVersion(b);
        const outs = outgoingRefs(notice, b.id);
        const ins = incomingRefs(notice, b.id);
        return (
          <div key={b.id} className={`block-box ${broken.has(b.id) ? 'block-broken' : ''}`}>
            <div className="block-head">
              <b>
                {idx + 1}. {BLOCK_KIND_LABEL[b.kind]}
              </b>
              <Badge text={`当前源文 v${v}`} tone="blue" />
              {broken.has(b.id) && <Badge text="待修复引用" tone="red" />}
            </div>
            <div className="source-text">{currentSourceText(b)}</div>
            <details>
              <summary>版本历史（{b.versions.length}）</summary>
              {[...b.versions].reverse().map((ver) => (
                <div key={ver.version} className="version-line">
                  <Badge text={`v${ver.version}`} tone={ver.version === v ? 'green' : 'gray'} />
                  <span>{ver.text}</span>
                </div>
              ))}
            </details>
            <div className="muted small">
              引用：
              {outs.length === 0 && ins.length === 0 && '无（独立区块）'}
              {outs.map((r) => (
                <span key={r.toBlockId}> → 引用「{blockById(notice, r.toBlockId) ? BLOCK_KIND_LABEL[blockById(notice, r.toBlockId)!.kind] : r.toBlockId}」　</span>
              ))}
              {ins.map((r) => (
                <span key={r.fromBlockId}> ← 被「{BLOCK_KIND_LABEL[blockById(notice, r.fromBlockId)!.kind]}」引用　</span>
              ))}
            </div>

            <div className="row-actions">
              <button disabled={locked || idx === 0} onClick={() => void move(b.id, -1)}>↑ 前移</button>
              <button disabled={locked || idx === blocks.length - 1} onClick={() => void move(b.id, 1)}>↓ 后移</button>
              <button
                className="danger"
                disabled={locked}
                onClick={async () => {
                  if (window.confirm(`删除区块「${BLOCK_KIND_LABEL[b.kind]}」？被其他区块引用时将产生待修复引用。`))
                    await send({ type: 'DeleteBlock', noticeId: notice.id, blockId: b.id });
                }}
              >
                删除
              </button>
            </div>

            <div className="revise-row">
              <textarea
                placeholder="修订后的新源文（提交后生成新版本，旧版保留）"
                rows={2}
                value={drafts[b.id] ?? ''}
                onChange={(e) => setDrafts((m) => ({ ...m, [b.id]: e.target.value }))}
              />
              <button
                disabled={locked || !(drafts[b.id] ?? '').trim()}
                onClick={async () => {
                  await send({ type: 'ReviseBlock', noticeId: notice.id, blockId: b.id, text: drafts[b.id]! });
                  setDrafts((m) => ({ ...m, [b.id]: '' }));
                }}
              >
                提交修订（v{v + 1}）
              </button>
            </div>
          </div>
        );
      })}

      <RefEditor state={state} notice={notice} send={send} />
    </Card>
  );
}

function RefEditor({ notice, send }: { state: NoticeState; notice: Notice; send: Send }) {
  const blocks = liveBlocks(notice);
  const [from, setFrom] = useState(blocks[2]?.id ?? blocks[0]?.id ?? '');
  const [to, setTo] = useState(blocks[1]?.id ?? blocks[0]?.id ?? '');
  if (blocks.length < 2) return null;
  // 区块被删除后，失效取值回退到当前有效区块
  const fromVal = blocks.some((b) => b.id === from) ? from : blocks[0].id;
  const toVal = blocks.some((b) => b.id === to) ? to : blocks[0].id;
  return (
    <details className="ref-editor">
      <summary>登记 / 修复区块引用</summary>
      <div className="form-grid">
        <label>
          引用方
          <select value={fromVal} onChange={(e) => setFrom(e.target.value)}>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>{BLOCK_KIND_LABEL[b.kind]}</option>
            ))}
          </select>
        </label>
        <label>
          被引用
          <select value={toVal} onChange={(e) => setTo(e.target.value)}>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>{BLOCK_KIND_LABEL[b.kind]}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="row-actions">
        <button
          disabled={isPublishedNow(notice) || !fromVal || !toVal || fromVal === toVal}
          onClick={async () => {
            const existing = notice.refs.filter((r) => r.fromBlockId !== fromVal);
            await send({ type: 'SetBlockRefs', noticeId: notice.id, refs: [...existing, { fromBlockId: fromVal, toBlockId: toVal }] });
          }}
        >
          保存引用（替换该区块现有引用）
        </button>
        <button
          className="ghost"
          disabled={isPublishedNow(notice)}
          onClick={() => void send({ type: 'SetBlockRefs', noticeId: notice.id, refs: [] })}
        >
          清空全部引用
        </button>
      </div>
      <div className="muted small">当前引用：{notice.refs.map((r) => `${BLOCK_KIND_LABEL[blockById(notice, r.fromBlockId)?.kind ?? 'subject']}→${BLOCK_KIND_LABEL[blockById(notice, r.toBlockId)?.kind ?? 'subject']}`).join('；') || '无'}</div>
    </details>
  );
}
