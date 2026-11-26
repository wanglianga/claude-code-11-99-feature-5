import type { ReactNode } from 'react';
import { checkInvariants } from '../engine/engine';
import { fmtDateTime } from '../engine/format';
import type { NoticeState, Receipt } from '../engine/types';

export function Badge({ text, tone = 'gray' }: { text: string; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{text}</span>;
}

export function Card({ title, extra, children }: { title?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {title && (
        <div className="card-head">
          <span className="panel-title">{title}</span>
          {extra}
        </div>
      )}
      {children}
    </div>
  );
}

const RECEIPT_KIND_LABEL: Record<string, string> = {
  seed: '初始化',
  reset: '重置',
  notice_created: '新建通知',
  block_revised: '源文修订',
  blocks_reordered: '区块换序',
  block_deleted: '删除区块',
  refs_updated: '引用更新',
  review_mode_switched: '审阅模式',
  translation_saved: '译文保存',
  review_approved: '审阅批准',
  review_rejected: '审阅退回',
  review_late: '旧审阅晚到',
  notice_published: '发布',
  notice_withdrawn: '撤回',
  ack_recorded: '确认知悉',
  assist_submitted: '协助请求',
  ack_duplicate: '重复确认',
  ack_rejected: '确认被拒',
  family_moved_out: '家庭迁出',
  delivery_swept: '模拟投递',
  clock_advanced: '时钟',
  duplicate_submission: '重复回执',
};

export function ReceiptsPanel({ receipts }: { receipts: Receipt[] }) {
  const sorted = [...receipts].sort((a, b) => b.seq - a.seq).slice(0, 100);
  return (
    <Card title={`操作回执（${receipts.length}）`}>
      {sorted.map((r) => (
        <div key={r.id} className={`receipt ${r.duplicateOf ? 'receipt-dup' : ''}`}>
          <div className="receipt-head">
            <span className="receipt-seq">#{r.seq}</span>
            <span className="muted">{fmtDateTime(r.at)}</span>
            <Badge text={RECEIPT_KIND_LABEL[r.kind] ?? r.kind} tone="gray" />
            <span className="muted">{r.actor}</span>
            {r.duplicateOf && <Badge text={`重复·原${r.duplicateOf}`} tone="blue" />}
          </div>
          <div>{r.summary}</div>
          {r.lines.filter(Boolean).map((l, i) => (
            <div key={i} className="muted receipt-line">
              {l}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

export function InvariantsPanel({ state }: { state: NoticeState }) {
  const results = checkInvariants(state);
  return (
    <Card title="规则核对（发布完整性 / 收悉口径 / 引用闭合 / 迁出不投递）">
      {results.map((r) => (
        <div key={r.name} className={`invariant ${r.ok ? 'inv-ok' : 'inv-bad'}`}>
          <span>{r.ok ? '✓' : '✗'}</span>
          <span>
            <b>{r.name}</b>　<span className="muted">{r.detail}</span>
          </span>
        </div>
      ))}
    </Card>
  );
}
