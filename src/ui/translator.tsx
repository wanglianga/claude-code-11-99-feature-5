import { useState } from 'react';
import {
  BLOCK_KIND_LABEL,
  LANG_LABEL,
  blockReviewStatus,
  currentSourceText,
  latestVersion,
  liveBlocks,
  outgoingRefs,
  translationOf,
  translationReady,
  wholeReviewStatus,
} from '../engine/selectors';
import type { Lang, Notice, NoticeState } from '../engine/types';
import type { Send } from './common';
import { Badge, Card } from './widgets';

function reviewBadge(status: { status: 'approved' | 'stale'; reason?: string }, prefix = '') {
  return status.status === 'approved' ? (
    <Badge text={`${prefix}已批准·有效`} tone="green" />
  ) : (
    <Badge text={`${prefix}待重审`} tone="red" />
  );
}

/** 译文审阅工作台 */
export function TranslatorWorkbench({
  state,
  notice,
  send,
}: {
  state: NoticeState;
  notice: Notice;
  send: Send;
}) {
  const [lang, setLang] = useState<Lang>('en');
  const blocks = liveBlocks(notice);

  return (
    <Card
      title={
        <>
          译文与审阅（{notice.reviewMode === 'whole' ? '整份审阅' : '区块审阅'}）
          <div className="lang-tabs">
            {state.languages.map((l) => (
              <button key={l} className={`lang-tab ${lang === l ? 'active' : ''}`} onClick={() => setLang(l)}>
                {LANG_LABEL[l]}
              </button>
            ))}
          </div>
        </>
      }
    >
      <div className="muted small">
        译文必须绑定「本区块源文版本 + 依赖区块版本」一起审核；只改译文编辑时间不能让旧审阅复活。审阅有效性以版本快照实时判定。
      </div>

      {notice.reviewMode === 'whole' && <WholeReviewPanel state={state} notice={notice} lang={lang} send={send} />}

      {blocks.map((b) => (
        <TranslationBlock key={b.id} state={state} notice={notice} blockId={b.id} lang={lang} send={send} />
      ))}
    </Card>
  );
}

function TranslationBlock({
  state,
  notice,
  blockId,
  lang,
  send,
}: {
  state: NoticeState;
  notice: Notice;
  blockId: string;
  lang: Lang;
  send: Send;
}) {
  const block = notice.blocks.find((b) => b.id === blockId)!;
  const cur = latestVersion(block);
  const t = translationOf(notice, blockId, lang);
  const [text, setText] = useState(t?.text ?? '');
  // 切换语言/区块时同步草稿
  const [key, setKey] = useState(`${blockId}-${lang}`);
  if (key !== `${blockId}-${lang}`) {
    setKey(`${blockId}-${lang}`);
    setText(t?.text ?? '');
  }
  const ready = translationReady(notice, blockId, lang);
  const outs = outgoingRefs(notice, blockId);
  const blockSt = blockReviewStatus(notice, blockId, lang);

  return (
    <div className="block-box">
      <div className="block-head">
        <b>{BLOCK_KIND_LABEL[block.kind]}</b>
        <Badge text={`源文 v${cur}`} tone="blue" />
        <Badge text={ready ? '译文已对齐当前源文' : `译文基于 v${t?.basedOnSourceVersion ?? 0}（待更新）`} tone={ready ? 'green' : 'orange'} />
        {notice.reviewMode === 'block' && reviewBadge(blockSt)}
      </div>
      <div className="source-text muted">{currentSourceText(block)}</div>
      {outs.length > 0 && (
        <div className="muted small">
          本区块引用：
          {outs.map((r) => {
            const target = notice.blocks.find((x) => x.id === r.toBlockId)!;
            return (
              <span key={r.toBlockId}>
                「{BLOCK_KIND_LABEL[target.kind]}」当前 v{latestVersion(target)}；该时刻被本区块引用，对方改版须连带重审
              </span>
            );
          })}
        </div>
      )}
      {blockSt.status === 'stale' && blockSt.reason && <div className="stale-reason">失效原因：{blockSt.reason}</div>}

      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`${LANG_LABEL[lang]}译文…`} />
      <div className="row-actions">
        <button onClick={() => void send({ type: 'SaveTranslation', noticeId: notice.id, blockId, lang, text })}>
          保存译文（绑定源文 v{cur}）
        </button>
        {notice.reviewMode === 'block' && (
          <>
            <button
              disabled={!ready}
              title={ready ? '' : '译文缺失或未对齐最新源文，不能批准'}
              onClick={() => void send({ type: 'SubmitBlockReview', noticeId: notice.id, blockId, lang, approve: true })}
            >
              批准本区块
            </button>
            <button className="ghost" onClick={() => void send({ type: 'SubmitBlockReview', noticeId: notice.id, blockId, lang, approve: false })}>
              退回
            </button>
            <button
              className="ghost"
              title="模拟旧审阅晚到：按上一版源文登记，到达后应立即失效"
              onClick={() =>
                void send({
                  type: 'SubmitBlockReview',
                  noticeId: notice.id,
                  blockId,
                  lang,
                  approve: true,
                  asOfVersions: { [blockId]: Math.max(1, cur - 1) },
                })
              }
            >
              模拟旧审阅晚到
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function WholeReviewPanel({
  state,
  notice,
  lang,
  send,
}: {
  state: NoticeState;
  notice: Notice;
  lang: Lang;
  send: Send;
}) {
  const st = wholeReviewStatus(notice, lang);
  const blocks = liveBlocks(notice);
  const allReady = blocks.every((b) => translationReady(notice, b.id, lang));
  return (
    <div className={`block-box ${st.status === 'approved' ? 'box-ok' : 'box-stale'}`}>
      <div className="block-head">
        <b>{LANG_LABEL[lang]} · 整份审阅</b>
        {reviewBadge(st)}
      </div>
      {st.status === 'stale' && st.reason && <div className="stale-reason">失效原因：{st.reason}</div>}
      <div className="muted small">整份审阅绑定全部区块源文版本、顺序与引用；任一区块修订或换序都要重审整份。</div>
      <div className="row-actions">
        <button
          disabled={!allReady}
          title={allReady ? '' : '存在缺译或未对齐译文，不能用缺译文本补成已批准'}
          onClick={() => void send({ type: 'SubmitWholeReview', noticeId: notice.id, lang, approve: true })}
        >
          批准整份（{LANG_LABEL[lang]}）
        </button>
        <button className="ghost" onClick={() => void send({ type: 'SubmitWholeReview', noticeId: notice.id, lang, approve: false })}>
          退回整份
        </button>
        <button
          className="ghost"
          title="模拟旧审阅晚到：按 v1 快照登记，到达后立即失效"
          onClick={() => {
            const asOf: Record<string, number> = {};
            for (const b of blocks) asOf[b.id] = 1;
            void send({ type: 'SubmitWholeReview', noticeId: notice.id, lang, approve: true, asOfVersions: asOf });
          }}
        >
          模拟旧审阅晚到（按 v1）
        </button>
      </div>
    </div>
  );
}
