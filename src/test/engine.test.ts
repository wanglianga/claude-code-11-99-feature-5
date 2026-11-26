import { describe, expect, it } from 'vitest';
import { DELIVERY_DELAY_REAL_MS, applyCommand, checkInvariants } from '../engine/engine';
import { seedState } from '../engine/seed';
import {
  blockReviewStatus,
  brokenRefs,
  currentPublication,
  isPublishedNow,
  latestVersion,
  liveBlocks,
  publicationAckStats,
  releaseCheck,
  wholeReviewStatus,
} from '../engine/selectors';
import type { Command, Lang, NoticeState, Role } from '../engine/types';

let cid = 0;
const nid = () => `test-${++cid}`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AnyCmd = DistributiveOmit<Command, 'commandId'> & { commandId?: string };

function run(state: NoticeState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000) {
  const full = { ...cmd, commandId: cmd.commandId ?? nid() } as Command;
  return applyCommand(state, full, { role, realNow });
}

function ok(state: NoticeState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000): NoticeState {
  const out = run(state, cmd, role, realNow);
  if (out.error) throw new Error(`命令意外失败: ${out.error}`);
  return out.state;
}

function fail(state: NoticeState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000): string {
  const out = run(state, cmd, role, realNow);
  if (!out.error) throw new Error('命令意外成功');
  return out.error;
}

function findNotice(s: NoticeState, id: string) {
  const n = s.notices.find((x) => x.id === id);
  if (!n) throw new Error(`通知不存在: ${id}`);
  return n;
}

const LANGS: Lang[] = ['zh', 'en', 'vi'];
const B1 = 'blk-1';
const B2 = 'blk-2';
const B3 = 'blk-3';

/** 把某通知某语言的全部区块译文保存为对齐当前源文的非空文本 */
function translateAll(s: NoticeState, noticeId: string, lang: Lang): NoticeState {
  const n = findNotice(s, noticeId);
  let cur = s;
  for (const b of liveBlocks(n)) {
    cur = ok(
      cur,
      { type: 'SaveTranslation', noticeId, blockId: b.id, lang, text: `[${lang}] 译文 v${latestVersion(b)}` },
      'translator',
    );
  }
  return cur;
}

function expectInvariantsOk(s: NoticeState) {
  const bad = checkInvariants(s).filter((r) => !r.ok);
  expect(bad.map((b) => `${b.name}: ${b.detail}`)).toEqual([]);
}

// ---------------------------------------------------------------------------

describe('种子数据对应题目示例', () => {
  it('三块三语言；第二块源文已到 v2（09:00→10:00），第三块引用第二块', () => {
    const s = seedState();
    for (const id of ['notice-whole', 'notice-block']) {
      const n = findNotice(s, id);
      expect(liveBlocks(n).map((b) => b.id)).toEqual([B1, B2, B3]);
      expect(latestVersion(findNotice(s, id).blocks.find((b) => b.id === B2)!)).toBe(2);
      const v1 = n.blocks.find((b) => b.id === B2)!.versions.find((v) => v.version === 1)!;
      const v2 = n.blocks.find((b) => b.id === B2)!.versions.find((v) => v.version === 2)!;
      expect(v1.text).toContain('09:00');
      expect(v2.text).toContain('10:00');
      expect(n.refs).toEqual([{ fromBlockId: B3, toBlockId: B2 }]);
    }
  });

  it('整份审阅通知：三语言整份审阅全部失效；区块通知：第一块有效、第二三块失效', () => {
    const s = seedState();
    const whole = findNotice(s, 'notice-whole');
    for (const lang of LANGS) expect(wholeReviewStatus(whole, lang).status).toBe('stale');
    const block = findNotice(s, 'notice-block');
    for (const lang of LANGS) {
      expect(blockReviewStatus(block, B1, lang).status).toBe('approved'); // 第一块可沿用
      expect(blockReviewStatus(block, B2, lang).status).toBe('stale'); // 本区块升版
      expect(blockReviewStatus(block, B3, lang).status).toBe('stale'); // 依赖失效连带
      expect(blockReviewStatus(block, B3, lang).reason!).toContain('时间地点');
    }
  });

  it('初始两条通知都不具备发布条件（存在缺译/失效审阅）', () => {
    const s = seedState();
    expect(releaseCheck(s, findNotice(s, 'notice-whole')).canPublish).toBe(false);
    expect(releaseCheck(s, findNotice(s, 'notice-block')).canPublish).toBe(false);
  });
});

describe('整份审阅路径：局部修改拖住全部内容，各语言须重审整份', () => {
  it('补齐英/越译文后三语言逐一批准整份，缺一语言都不能发布', () => {
    let s = seedState();
    const id = 'notice-whole';
    // 仅补齐英文 → 中文、越南语仍未获批
    s = translateAll(s, id, 'en');
    s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang: 'en', approve: true }, 'translator');
    expect(wholeReviewStatus(findNotice(s, id), 'en').status).toBe('approved');
    fail(s, { type: 'Publish', noticeId: id }, 'duty');

    s = translateAll(s, id, 'vi');
    s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang: 'vi', approve: true }, 'translator');
    // 中文译文已对齐（种子内），直接批准
    s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang: 'zh', approve: true }, 'translator');
    const check = releaseCheck(s, findNotice(s, id));
    expect(check.canPublish).toBe(true);
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    const n = findNotice(s, id);
    expect(isPublishedNow(n)).toBe(true);
    expect(currentPublication(n)!.version).toBe(1);
    // 投递名单 = A 楼 4 名在住住户，模拟短信入队
    expect(currentPublication(n)!.recipientResidentIds).toHaveLength(4);
    expect(s.deliveries.filter((d) => d.noticeId === id).length).toBe(4);
    expectInvariantsOk(s);
  });

  it('发布前任一区块再修订，整份审阅再次全部失效', () => {
    let s = seedState();
    const id = 'notice-whole';
    for (const lang of LANGS) {
      s = translateAll(s, id, lang);
      s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang, approve: true }, 'translator');
    }
    // 撤回前提：发布状态不能改源文；先在草稿态修订第一块
    s = ok(s, { type: 'ReviseBlock', noticeId: id, blockId: B1, text: '服务联系人改为分机 8002。' });
    for (const lang of LANGS) expect(wholeReviewStatus(findNotice(s, id), lang).status).toBe('stale');
    fail(s, { type: 'Publish', noticeId: id }, 'duty');
  });

  it('区块换序令整份审阅失效（组合与批准时不一致）', () => {
    let s = seedState();
    const id = 'notice-whole';
    for (const lang of LANGS) {
      s = translateAll(s, id, lang);
      s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang, approve: true }, 'translator');
    }
    s = ok(s, { type: 'ReorderBlocks', noticeId: id, orderedBlockIds: [B2, B1, B3] });
    expect(wholeReviewStatus(findNotice(s, id), 'zh').status).toBe('stale');
    expect(wholeReviewStatus(findNotice(s, id), 'zh').reason!).toContain('顺序');
  });
});

describe('区块审阅路径：无关译文沿用，仅重审后两块', () => {
  it('第一块译文与审阅沿用；只补 b2 英越译文并重审 b2/b3 即可发布', () => {
    let s = seedState();
    const id = 'notice-block';
    const before = findNotice(s, id);
    const b1ReviewZh = before.reviews.find((r) => r.scopeBlockId === B1 && r.lang === 'zh')!.id;

    // b2 英/越译文停在 v1，需重译；中文已对齐 v2
    s = ok(s, { type: 'SaveTranslation', noticeId: id, blockId: B2, lang: 'en', text: 'shuttle 10:00 v2' }, 'translator');
    s = ok(s, { type: 'SaveTranslation', noticeId: id, blockId: B2, lang: 'vi', text: 'xe 10:00 v2' }, 'translator');
    // 重审第二块三语言、第三块三语言（第一块不动）
    for (const lang of LANGS) {
      s = ok(s, { type: 'SubmitBlockReview', noticeId: id, blockId: B2, lang, approve: true }, 'translator');
      s = ok(s, { type: 'SubmitBlockReview', noticeId: id, blockId: B3, lang, approve: true }, 'translator');
    }
    const after = findNotice(s, id);
    // 第一块审阅记录未被替换，原样沿用
    expect(after.reviews.find((r) => r.scopeBlockId === B1 && r.lang === 'zh')!.id).toBe(b1ReviewZh);
    for (const lang of LANGS) {
      expect(blockReviewStatus(after, B1, lang).status).toBe('approved');
      expect(blockReviewStatus(after, B2, lang).status).toBe('approved');
      expect(blockReviewStatus(after, B3, lang).status).toBe('approved');
    }
    expect(releaseCheck(s, after).canPublish).toBe(true);
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    expect(isPublishedNow(findNotice(s, id))).toBe(true);
    expectInvariantsOk(s);
  });

  it('换序不影响区块审阅结论', () => {
    let s = seedState();
    const id = 'notice-block';
    s = ok(s, { type: 'ReorderBlocks', noticeId: id, orderedBlockIds: [B1, B3, B2] });
    // 第一块审阅仍有效（区块审阅不绑定整体顺序）
    expect(blockReviewStatus(findNotice(s, id), B1, 'zh').status).toBe('approved');
    expect(liveBlocks(findNotice(s, id)).map((b) => b.id)).toEqual([B1, B3, B2]);
  });

  it('修订被依赖区块时引用方审阅连带失效，且不能凭译文编辑时间复活', () => {
    let s = seedState();
    const id = 'notice-block';
    // 先让 b3 中文获批
    s = ok(s, { type: 'SubmitBlockReview', noticeId: id, blockId: B3, lang: 'zh', approve: true }, 'translator');
    expect(blockReviewStatus(findNotice(s, id), B3, 'zh').status).toBe('approved');
    // 再次修订 b2（v2→v3），b3 译文没动、编辑时间没变，但依赖版本失效
    s = ok(s, { type: 'ReviseBlock', noticeId: id, blockId: B2, text: '班车安排：班车 11:00 在 A 楼门口发车。' });
    const st = blockReviewStatus(findNotice(s, id), B3, 'zh');
    expect(st.status).toBe('stale');
    expect(st.reason!).toContain('依赖');
  });
});

describe('旧审阅晚到：到达即失效，不能补成已批准', () => {
  it('区块审阅按旧版快照登记，到达后立即 stale 且阻止发布', () => {
    let s = seedState();
    const id = 'notice-block';
    s = ok(
      s,
      { type: 'SubmitBlockReview', noticeId: id, blockId: B2, lang: 'en', approve: true, asOfVersions: { [B2]: 1 } },
      'translator',
    );
    const st = blockReviewStatus(findNotice(s, id), B2, 'en');
    expect(st.status).toBe('stale');
    const lateReceipt = s.receipts.find((r) => r.kind === 'review_late');
    expect(lateReceipt).toBeTruthy();
    expect(releaseCheck(s, findNotice(s, id)).canPublish).toBe(false);
  });

  it('整份审阅按 v1 晚到，当前已是 v2 组合，到达即失效', () => {
    let s = seedState();
    const id = 'notice-whole';
    s = translateAll(s, id, 'zh');
    const asOf: Record<string, number> = { [B1]: 1, [B2]: 1, [B3]: 1 };
    s = ok(s, { type: 'SubmitWholeReview', noticeId: id, lang: 'zh', approve: true, asOfVersions: asOf }, 'translator');
    expect(wholeReviewStatus(findNotice(s, id), 'zh').status).toBe('stale');
  });

  it('缺译文不能批准（不能用缺译文本补成已批准）', () => {
    const s = seedState();
    const id = 'notice-block';
    const err = fail(s, { type: 'SubmitBlockReview', noticeId: id, blockId: B2, lang: 'en', approve: true }, 'translator');
    expect(err).toContain('缺译');
  });
});

describe('删除被引用区块：引用方待修复，禁止发布残缺指示', () => {
  it('删除第二块后第三块成为待修复引用，发布被拦截；修复引用后缺口解除', () => {
    let s = seedState();
    const id = 'notice-block';
    s = ok(s, { type: 'DeleteBlock', noticeId: id, blockId: B2 });
    const n = findNotice(s, id);
    expect(brokenRefs(n).map((r) => r.fromBlockId)).toEqual([B3]);
    const issues = releaseCheck(s, n).issues.map((i) => i.detail).join();
    expect(issues).toContain('待修复引用');
    const err = fail(s, { type: 'Publish', noticeId: id }, 'duty');
    expect(err).toContain('待修复引用');
    // 修复：移除悬空引用
    s = ok(s, { type: 'SetBlockRefs', noticeId: id, refs: [] });
    const refIssues = releaseCheck(s, findNotice(s, id)).issues.filter((i) => i.scope === '引用');
    expect(refIssues).toEqual([]);
    expect(brokenRefs(findNotice(s, id))).toHaveLength(0);
  });
});

describe('发布、撤回与收悉', () => {
  function readyBlockNotice(s: NoticeState): NoticeState {
    let cur = s;
    const id = 'notice-block';
    cur = ok(cur, { type: 'SaveTranslation', noticeId: id, blockId: B2, lang: 'en', text: 'v2 en' }, 'translator');
    cur = ok(cur, { type: 'SaveTranslation', noticeId: id, blockId: B2, lang: 'vi', text: 'v2 vi' }, 'translator');
    for (const lang of LANGS) {
      cur = ok(cur, { type: 'SubmitBlockReview', noticeId: id, blockId: B2, lang, approve: true }, 'translator');
      cur = ok(cur, { type: 'SubmitBlockReview', noticeId: id, blockId: B3, lang, approve: true }, 'translator');
    }
    return cur;
  }

  it('发布数量不等于收悉人数；逐人确认后缺口下降，模拟投递可结算', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty', 1000);
    let n = findNotice(s, id);
    const stats0 = publicationAckStats(s, n, currentPublication(n)!);
    expect(stats0.recipients).toBe(4);
    expect(stats0.ackedCount).toBe(0);
    expect(stats0.gapCount).toBe(4); // 发布 4 人 ≠ 收悉 0 人
    // 两名住户确认
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    s = ok(s, { type: 'ResidentAck', residentId: 'res-li', noticeId: id, kind: 'assist', assistNote: '需要轮椅接送' }, 'resident');
    n = findNotice(s, id);
    const stats1 = publicationAckStats(s, n, currentPublication(n)!);
    expect(stats1.ackedCount).toBe(2);
    expect(stats1.gapCount).toBe(2);
    expect(stats1.assistCount).toBe(1);
    // 模拟适配器结算
    s = ok(s, { type: 'SweepDeliveries' }, 'duty', 1000 + DELIVERY_DELAY_REAL_MS + 1);
    expect(s.deliveries.every((d) => d.status === 'delivered')).toBe(true);
    expectInvariantsOk(s);
  });

  it('同一版本两标签重复确认仅记一次（幂等）', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    // 两个标签各自生成不同 commandId，但住户+通知+发布版本相同
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    const acks = s.acknowledgements.filter((a) => a.residentId === 'res-wang' && a.noticeId === id);
    expect(acks).toHaveLength(1);
    expect(s.receipts.some((r) => r.kind === 'ack_duplicate')).toBe(true);
  });

  it('撤回后居民才点击确认：拒绝并留痕，不计入收悉', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    s = ok(s, { type: 'Withdraw', noticeId: id }, 'duty');
    // 被拒命令仍会把尝试写入 rejectedClicks（留痕），但不计入收悉
    const out = run(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    expect(out.error).toContain('撤回');
    s = out.state;
    expect(s.acknowledgements.filter((a) => a.noticeId === id)).toHaveLength(0);
    expect(s.rejectedClicks.filter((c) => c.noticeId === id)).toHaveLength(1);
  });

  it('旧确认不算知悉新版本：再发布后须重新确认，两次回复按版本分别保留', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    s = ok(s, { type: 'Withdraw', noticeId: id }, 'duty');
    // 不改源文直接再次发布（审阅仍有效）→ v2
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    const n = findNotice(s, id);
    expect(currentPublication(n)!.version).toBe(2);
    const v2Stats = publicationAckStats(s, n, currentPublication(n)!);
    expect(v2Stats.ackedCount).toBe(0); // v1 的确认不算 v2 收悉
    // v1 回复仍保留
    expect(s.acknowledgements.some((a) => a.publicationVersion === 1 && a.residentId === 'res-wang')).toBe(true);
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    expect(publicationAckStats(s, n, currentPublication(n)!).ackedCount).toBe(1);
    expectInvariantsOk(s);
  });

  it('家庭迁出后不再进入新发布名单，此前回复保留出处', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    s = ok(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    // 王芳一家（fam-1：王芳、王小明）迁出
    s = ok(s, { type: 'MoveOutFamily', familyId: 'fam-1' });
    expect(s.residents.find((r) => r.id === 'res-wang')!.status).toBe('moved_out');
    s = ok(s, { type: 'Withdraw', noticeId: id }, 'duty');
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    const pub2 = currentPublication(findNotice(s, id))!;
    expect(pub2.recipientResidentIds.sort()).toEqual(['res-li', 'res-lisa'].sort());
    // 历史回复仍在，且记录点击时状态
    const old = s.acknowledgements.find((a) => a.residentId === 'res-wang')!;
    expect(old.residentStatusAtClick).toBe('living');
    // 迁出住户点击被拒
    fail(s, { type: 'ResidentAck', residentId: 'res-wang', noticeId: id, kind: 'ack' }, 'resident');
    expectInvariantsOk(s);
  });

  it('已发布通知拒绝源文修订，须先撤回', () => {
    let s = readyBlockNotice(seedState());
    const id = 'notice-block';
    s = ok(s, { type: 'Publish', noticeId: id }, 'duty');
    const err = fail(s, { type: 'ReviseBlock', noticeId: id, blockId: B1, text: '改' });
    expect(err).toContain('先撤回');
  });
});

describe('角色权限与幂等', () => {
  it('接待员不能发布、翻译不能改源文、值班负责人不能译', () => {
    const s = seedState();
    expect(fail(s, { type: 'Publish', noticeId: 'notice-block' }, 'receptionist')).toContain('无权');
    expect(fail(s, { type: 'ReviseBlock', noticeId: 'notice-block', blockId: B1, text: 'x' }, 'translator')).toContain('无权');
    expect(
      fail(s, { type: 'SaveTranslation', noticeId: 'notice-block', blockId: B1, lang: 'en', text: 'x' }, 'duty'),
    ).toContain('无权');
  });

  it('相同 commandId 重发只生效一次并开具重复回执', () => {
    const s = seedState();
    const cmd = {
      type: 'MoveOutFamily',
      commandId: 'move-1',
      familyId: 'fam-1',
    } as const;
    const s1 = run(s, cmd).state;
    const s2 = run(s1, cmd).state;
    expect(s2.residents.filter((r) => r.familyId === 'fam-1' && r.status === 'moved_out')).toHaveLength(2);
    expect(s2.receipts.filter((r) => r.kind === 'duplicate_submission')).toHaveLength(1);
  });
});

describe('新建通知的缺译拦截', () => {
  it('新通知三语言译文为空，发布完整性校验失败并指明缺译', () => {
    let s = seedState();
    s = ok(s, {
      type: 'CreateNotice',
      input: {
        title: '餐点配送通知',
        targetType: 'building',
        targetId: 'bld-A',
        blocks: [
          { kind: 'subject', text: '餐点主题' },
          { kind: 'time_place', text: '12:00 在餐厅' },
          { kind: 'action', text: '请凭卡领餐' },
        ],
        refIndices: [[2, 1]],
      },
    });
    const n = s.notices[s.notices.length - 1];
    const check = releaseCheck(s, n);
    expect(check.canPublish).toBe(false);
    expect(check.issues.some((i) => i.detail.includes('缺译'))).toBe(true);
    fail(s, { type: 'Publish', noticeId: n.id }, 'duty');
    expectInvariantsOk(s);
  });
});
