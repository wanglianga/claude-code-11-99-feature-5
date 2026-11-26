import { fmtDateTime } from './format';
import { seedState } from './seed';
import {
  LANG_LABEL,
  blockById,
  blocksWithBrokenRefs,
  brokenRefs,
  currentPublication,
  currentRefSignature,
  isPublishedNow,
  latestVersion,
  liveBlocks,
  outgoingRefs,
  revalidateReviews,
  releaseCheck,
  refSignature,
  residentById,
  targetResidents,
  translationOf,
  translationReady,
} from './selectors';
import type {
  Acknowledgement,
  Block,
  BlockRef,
  CmdCtx,
  CmdOutcome,
  Command,
  Notice,
  NoticeState,
  Publication,
  Receipt,
  RejectedClick,
  Review,
  Role,
  TranslationState,
} from './types';

/** 本地模拟适配器的投递时延（真实毫秒），不调用真实短信服务 */
export const DELIVERY_DELAY_REAL_MS = 1500;

const PERMS: Record<Command['type'], Role[] | 'any'> = {
  CreateNotice: ['receptionist'],
  ReviseBlock: ['receptionist'],
  ReorderBlocks: ['receptionist'],
  DeleteBlock: ['receptionist'],
  SetBlockRefs: ['receptionist'],
  SwitchReviewMode: ['receptionist'],
  SaveTranslation: ['translator'],
  SubmitWholeReview: ['translator'],
  SubmitBlockReview: ['translator'],
  Publish: ['duty'],
  Withdraw: ['duty'],
  ResidentAck: ['resident'],
  MoveOutFamily: ['receptionist', 'duty'],
  AdvanceClock: 'any',
  SweepDeliveries: 'any',
  ResetDemo: 'any',
};

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}

function clone(s: NoticeState): NoticeState {
  return structuredClone(s);
}

type ReceiptSink = (kind: string, summary: string, lines?: string[], extra?: Partial<Receipt>) => Receipt;

function addReceipt(
  state: NoticeState,
  kind: string,
  actor: string,
  summary: string,
  lines: string[] = [],
  extra?: Partial<Receipt>,
): Receipt {
  const seq = ++state.seqCounter;
  const r: Receipt = { seq, id: `R${seq}`, at: state.virtualNow, kind, actor, summary, lines, ...extra };
  state.receipts.push(r);
  if (state.receipts.length > 600) state.receipts.splice(0, state.receipts.length - 600);
  return r;
}

function summarize(cmd: Command): string {
  switch (cmd.type) {
    case 'CreateNotice':
      return `新建通知「${cmd.input.title}」`;
    case 'ReviseBlock':
      return '修订区块源文';
    case 'ReorderBlocks':
      return '区块换序';
    case 'DeleteBlock':
      return '删除区块';
    case 'SetBlockRefs':
      return '登记/修复区块引用';
    case 'SaveTranslation':
      return '保存译文';
    case 'SubmitWholeReview':
      return '整份审阅';
    case 'SubmitBlockReview':
      return '区块审阅';
    case 'Publish':
      return '发布通知';
    case 'Withdraw':
      return '撤回通知';
    case 'ResidentAck':
      return cmd.kind === 'assist' ? '住户提交协助请求' : '住户确认知悉';
    case 'MoveOutFamily':
      return '家庭迁出';
    case 'AdvanceClock':
      return '推进演示时间';
    case 'SweepDeliveries':
      return '投递适配器结算';
    case 'ResetDemo':
      return '重置演示数据';
    default:
      return cmd.type;
  }
}

export function applyCommand(prev: NoticeState, cmd: Command, ctx: CmdCtx): CmdOutcome {
  if (cmd.type === 'ResetDemo') {
    const fresh = seedState();
    const r = addReceipt(fresh, 'reset', roleLabel(ctx.role), '演示数据已重置为初始场景');
    return { state: fresh, receipts: [r], changed: true };
  }

  // 幂等：同一 commandId 只生效一次
  const seen = prev.commandLog.find((e) => e.commandId === cmd.commandId);
  if (seen) {
    const state = clone(prev);
    const r = addReceipt(
      state,
      'duplicate_submission',
      roleLabel(ctx.role),
      `重复提交已幂等忽略：${seen.summary}`,
      [`原回执：${seen.receiptIds.join('、') || '（无）'}`, '同一 commandId 的命令只会生效一次，状态未发生变化'],
      { duplicateOf: seen.receiptIds[0] },
    );
    state.version++;
    return { state, receipts: [r], changed: true };
  }

  const state = clone(prev);
  const receipts: Receipt[] = [];
  const R: ReceiptSink = (kind, summary, lines = [], extra) => {
    const r = addReceipt(state, kind, roleLabel(ctx.role), summary, lines, extra);
    receipts.push(r);
    return r;
  };

  const error = dispatch(state, cmd, ctx, R);

  const mutated = receipts.length > 0 || !!error;
  if (!mutated) return { state: prev, receipts: [], changed: false };

  state.version++;
  state.commandLog.push({
    commandId: cmd.commandId,
    at: state.virtualNow,
    ok: !error,
    summary: summarize(cmd),
    receiptIds: receipts.map((r) => r.id),
  });
  if (state.commandLog.length > 300) state.commandLog.splice(0, state.commandLog.length - 300);
  return { state, receipts, error, changed: true };
}

function roleLabel(role: Role): string {
  const map: Record<Role, string> = {
    receptionist: '接待员',
    translator: '翻译志愿者',
    duty: '值班负责人',
    resident: '住户',
  };
  return map[role];
}

function dispatch(state: NoticeState, cmd: Command, ctx: CmdCtx, R: ReceiptSink): string | undefined {
  const perm = PERMS[cmd.type];
  if (perm !== 'any' && !perm.includes(ctx.role)) {
    return `当前角色（${roleLabel(ctx.role)}）无权执行此操作，需要：${perm.map(roleLabel).join('或')}`;
  }
  switch (cmd.type) {
    case 'CreateNotice':
      return hCreateNotice(state, cmd, R);
    case 'ReviseBlock':
      return hReviseBlock(state, cmd, R);
    case 'ReorderBlocks':
      return hReorder(state, cmd, R);
    case 'DeleteBlock':
      return hDeleteBlock(state, cmd, R);
    case 'SetBlockRefs':
      return hSetRefs(state, cmd, R);
    case 'SwitchReviewMode':
      return hSwitchMode(state, cmd, R);
    case 'SaveTranslation':
      return hSaveTranslation(state, cmd, R);
    case 'SubmitWholeReview':
      return hWholeReview(state, cmd, R);
    case 'SubmitBlockReview':
      return hBlockReview(state, cmd, R);
    case 'Publish':
      return hPublish(state, cmd, ctx, R);
    case 'Withdraw':
      return hWithdraw(state, cmd, R);
    case 'ResidentAck':
      return hResidentAck(state, cmd, R);
    case 'MoveOutFamily':
      return hMoveOut(state, cmd, R);
    case 'AdvanceClock':
      return hAdvance(state, cmd, R);
    case 'SweepDeliveries':
      return hSweep(state, ctx, R);
    default:
      return '未知命令';
  }
}

function getNotice(state: NoticeState, noticeId: string): Notice | undefined {
  return state.notices.find((n) => n.id === noticeId);
}

function editable(notice: Notice): boolean {
  return notice.status !== 'published';
}

// ---------------------------------------------------------------------------
// 接待员：源文编辑
// ---------------------------------------------------------------------------

function hCreateNotice(
  state: NoticeState,
  cmd: Extract<Command, { type: 'CreateNotice' }>,
  R: ReceiptSink,
): string | undefined {
  const { title, targetType, targetId, blocks: blockInputs, refIndices } = cmd.input;
  if (!title.trim()) return '通知标题不能为空';
  if (blockInputs.length === 0) return '通知至少需要一个区块';
  const targetOk =
    targetType === 'building'
      ? state.buildings.some((b) => b.id === targetId)
      : state.families.some((f) => f.id === targetId);
  if (!targetOk) return '投递目标不存在';

  const blocks: Block[] = blockInputs.map((b, i) => ({
    id: uid(),
    kind: b.kind,
    order: i,
    deleted: false,
    versions: [{ version: 1, text: b.text, revisedAt: state.virtualNow }],
  }));
  const idSet = new Set(blocks.map((b) => b.id));
  const cleanRefs: BlockRef[] = refIndices
    .filter(([fi, ti]) => fi >= 0 && ti >= 0 && fi < blocks.length && ti < blocks.length && fi !== ti)
    .map(([fi, ti]) => ({ fromBlockId: blocks[fi].id, toBlockId: blocks[ti].id }));

  const translations: Record<string, TranslationState[]> = {};
  for (const b of blocks) {
    translations[b.id] = state.languages.map((lang) => ({
      lang,
      text: '',
      basedOnSourceVersion: 0,
      editedAt: state.virtualNow,
    }));
  }
  const notice: Notice = {
    id: uid(),
    title: title.trim(),
    reviewMode: 'block',
    targetType,
    targetId,
    status: 'draft',
    blocks,
    refs: cleanRefs,
    translations,
    reviews: [],
    publications: [],
    createdAt: state.virtualNow,
    updatedAt: state.virtualNow,
  };
  state.notices.push(notice);
  R('notice_created', `已新建通知「${notice.title}」（${blocks.length} 个区块，${state.languages.length} 种必需语言）`, [
    `引用登记：${cleanRefs.length} 条`,
    '新建通知默认走「区块审阅」；可在通知内切换为整份审阅（切换会清空当前审阅结论）',
  ]);
  return undefined;
}

/** 切换审阅工作流（接待员）：由专用命令承载，避免在 UI 里直接改状态 */
export function switchReviewMode(notice: Notice, mode: Notice['reviewMode']): void {
  if (notice.reviewMode === mode) return;
  notice.reviewMode = mode;
  notice.reviews = [];
}

function hSwitchMode(
  state: NoticeState,
  cmd: Extract<Command, { type: 'SwitchReviewMode' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!editable(notice)) return '通知已发布，请先撤回再切换审阅模式';
  if (notice.reviewMode === cmd.mode) return '通知已是该审阅模式';
  const from = notice.reviewMode === 'whole' ? '整份审阅' : '区块审阅';
  const to = cmd.mode === 'whole' ? '整份审阅' : '区块审阅';
  switchReviewMode(notice, cmd.mode);
  R('review_mode_switched', `审阅模式已由「${from}」切换为「${to}」`, [
    '切换会清空现有审阅结论，须按新模式重新组织审阅；源文、译文与版本历史保留',
  ]);
  return undefined;
}

function hReviseBlock(
  state: NoticeState,
  cmd: Extract<Command, { type: 'ReviseBlock' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!editable(notice)) return '通知处于已发布状态，请先撤回再修订源文';
  const block = blockById(notice, cmd.blockId);
  if (!block || block.deleted) return '区块不存在或已删除';
  const text = cmd.text.trim();
  if (!text) return '修订内容不能为空';
  if (text === block.versions[block.versions.length - 1].text) return '内容与当前源文一致，无需修订';
  const prevVersion = latestVersion(block);
  block.versions.push({ version: prevVersion + 1, text, revisedAt: state.virtualNow });
  notice.updatedAt = state.virtualNow;
  revalidateReviews(notice);
  const impacted = impactedReviews(notice);
  R(
    'block_revised',
    `区块源文已修订：v${prevVersion} → v${prevVersion + 1}`,
    [
      `旧版本完整保留（可追溯 09:00→10:00 等历次修改），译文不会自动跟随，须由翻译志愿者按新版源文更新`,
      `审阅有效性凭源文版本判定，本次共令 ${impacted} 条审阅结论失效（${notice.reviewMode === 'whole' ? '整份审阅：各语言均须重审整份' : '区块审阅：本区块及引用它的区块须重审，无关区块译文可沿用'}）`,
    ],
  );
  return undefined;
}

function impactedReviews(notice: Notice): number {
  return notice.reviews.filter((r) => r.status === 'stale').length;
}

function hReorder(
  state: NoticeState,
  cmd: Extract<Command, { type: 'ReorderBlocks' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!editable(notice)) return '通知已发布，请先撤回再调整区块顺序';
  const live = liveBlocks(notice);
  const want = [...cmd.orderedBlockIds].sort();
  const have = live.map((b) => b.id).sort();
  if (want.length !== have.length || want.some((id, i) => id !== have[i]))
    return '换序列表必须恰好包含当前全部有效区块';
  live.forEach((b, i) => {
    const idx = cmd.orderedBlockIds.indexOf(b.id);
    b.order = idx;
  });
  revalidateReviews(notice);
  const wholeStale = notice.reviewMode === 'whole' && notice.reviews.some((r) => r.status === 'stale');
  R('blocks_reordered', '区块顺序已调整', [
    wholeStale
      ? '整份审阅绑定了批准时的区块顺序，换序后整份审阅失效，须重审整份'
      : '区块审阅以单区块为单位，换序不影响各区块已获批的审阅结论',
  ]);
  return undefined;
}

function hDeleteBlock(
  state: NoticeState,
  cmd: Extract<Command, { type: 'DeleteBlock' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!editable(notice)) return '通知已发布，请先撤回再删除区块';
  const block = blockById(notice, cmd.blockId);
  if (!block || block.deleted) return '区块不存在或已删除';
  block.deleted = true;
  // 重排剩余有效区块，保持顺序连续（换序/删除后组合仍完整可理解）
  liveBlocks(notice).forEach((b, i) => {
    b.order = i;
  });
  notice.updatedAt = state.virtualNow;
  revalidateReviews(notice);
  const broken = blocksWithBrokenRefs(notice);
  const lines: string[] = [
    '区块已逻辑删除（版本与译文保留可追溯），不再进入发布组合',
  ];
  if (broken.has(block.id) || broken.size > 0) {
    lines.push(
      `存在引用该区块的其他区块（${[...broken].map((id) => kindName(notice, id)).join('、')}），已标记为「待修复引用」，修复前不能发布，不会发出残缺指示`,
    );
  }
  R('block_deleted', `已删除区块「${kindName(notice, block.id)}」`, lines);
  return undefined;
}

function kindName(notice: Notice, blockId: string): string {
  const b = blockById(notice, blockId);
  if (!b) return blockId;
  const map = { subject: '主题/服务联系人', time_place: '时间地点', action: '行动说明' } as const;
  return map[b.kind];
}

function hSetRefs(
  state: NoticeState,
  cmd: Extract<Command, { type: 'SetBlockRefs' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!editable(notice)) return '通知已发布，请先撤回再调整引用';
  const liveIds = new Set(liveBlocks(notice).map((b) => b.id));
  for (const r of cmd.refs) {
    if (!liveIds.has(r.fromBlockId) || !liveIds.has(r.toBlockId))
      return '引用的区块不存在或已删除，请先恢复或改指有效区块';
    if (r.fromBlockId === r.toBlockId) return '区块不能引用自身';
  }
  notice.refs = cmd.refs.map((r) => ({ ...r }));
  revalidateReviews(notice);
  const broken = brokenRefs(notice);
  R('refs_updated', `区块引用已更新（${notice.refs.length} 条）`, [
    broken.length ? `仍有 ${broken.length} 条失效引用待修复` : '全部引用均指向有效区块，失效审阅须重新批准',
  ]);
  return undefined;
}

// ---------------------------------------------------------------------------
// 翻译志愿者：译文与审阅
// ---------------------------------------------------------------------------

function hSaveTranslation(
  state: NoticeState,
  cmd: Extract<Command, { type: 'SaveTranslation' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  const block = blockById(notice, cmd.blockId);
  if (!block || block.deleted) return '区块不存在或已删除';
  const list = notice.translations[cmd.blockId];
  let t = list.find((x) => x.lang === cmd.lang);
  const baseVersion = latestVersion(block);
  if (!t) {
    t = { lang: cmd.lang, text: cmd.text, basedOnSourceVersion: baseVersion, editedAt: state.virtualNow };
    list.push(t);
  } else {
    t.text = cmd.text;
    t.basedOnSourceVersion = baseVersion;
    t.editedAt = state.virtualNow;
  }
  revalidateReviews(notice);
  R(
    'translation_saved',
    `已保存${LANG_LABEL[cmd.lang]}译文：「${kindName(notice, block.id)}」（绑定源文 v${baseVersion}）`,
    [
      `译文有效性绑定源文版本 v${baseVersion}，不能只凭译文编辑时间判断；源文再修订后该译文需重新翻译`,
      translationReady(notice, block.id, cmd.lang) ? '该译文已可进入审阅' : '译文为空，尚不能审阅或发布',
    ],
  );
  return undefined;
}

function liveVersionMap(notice: Notice): Record<string, number> {
  const m: Record<string, number> = {};
  for (const b of liveBlocks(notice)) m[b.id] = latestVersion(b);
  return m;
}

function hWholeReview(
  state: NoticeState,
  cmd: Extract<Command, { type: 'SubmitWholeReview' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (notice.reviewMode !== 'whole') return '该通知采用区块审阅，请逐区块提交审阅';
  const blocks = liveBlocks(notice);
  if (!cmd.approve) {
    R('review_rejected', `${LANG_LABEL[cmd.lang]}整份审阅未通过，已退回修订`, ['未生成批准结论，通知仍不可发布']);
    return undefined;
  }
  // 晚到审阅登记的是旧版快照，到达后凭快照判定失效，不再以当前译文版本前置拦截
  if (!cmd.asOfVersions) {
    for (const b of blocks) {
      if (!translationReady(notice, b.id, cmd.lang))
        return `「${kindName(notice, b.id)}」缺译或译文未基于最新源文，不能用缺译文本补成已批准`;
    }
  }
  if (brokenRefs(notice).length) return '存在待修复引用，不能批准整份审阅';

  const late = !!cmd.asOfVersions;
  const versions = cmd.asOfVersions ?? liveVersionMap(notice);
  const review: Review = {
    id: uid(),
    mode: 'whole',
    lang: cmd.lang,
    sourceSnapshot: { ...versions },
    orderSignature: blocks.map((b) => b.id),
    refSignature: currentRefSignature(notice),
    status: 'approved',
    decidedAt: state.virtualNow,
  };
  const priorIdx = notice.reviews.findIndex((r) => r.mode === 'whole' && r.lang === cmd.lang);
  if (priorIdx >= 0) notice.reviews.splice(priorIdx, 1, review);
  else notice.reviews.push(review);
  revalidateReviews(notice);

  if (late && review.status === 'stale') {
    R(
      'review_late',
      `${LANG_LABEL[cmd.lang]}整份审阅「晚到」：登记的是旧版快照，到达即失效`,
      [`失效原因：${review.staleReason}`, '旧审阅不能覆盖当前源文，须按最新版本重新审阅后才能发布'],
    );
    return undefined;
  }
  R('review_approved', `${LANG_LABEL[cmd.lang]}整份审阅已批准`, [
    `绑定 ${blocks.length} 个区块源文版本、区块顺序与引用关系；任一区块再修订都须重审整份`,
  ]);
  return undefined;
}

function hBlockReview(
  state: NoticeState,
  cmd: Extract<Command, { type: 'SubmitBlockReview' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (notice.reviewMode !== 'block') return '该通知采用整份审阅，请提交整份审阅';
  const block = blockById(notice, cmd.blockId);
  if (!block || block.deleted) return '区块不存在或已删除';
  if (!cmd.approve) {
    R('review_rejected', `${LANG_LABEL[cmd.lang]}区块审阅未通过：「${kindName(notice, block.id)}」已退回`, [
      '未生成批准结论',
    ]);
    return undefined;
  }
  // 晚到审阅登记旧版快照、到达即失效，不以当前译文版本前置拦截
  if (!cmd.asOfVersions) {
    if (!translationReady(notice, block.id, cmd.lang))
      return '该区块译文缺失或未基于最新源文，不能用缺译文本补成已批准';
  }
  const out = outgoingRefs(notice, block.id);
  if (out.some((r) => brokenRefs(notice).some((br) => br.fromBlockId === r.fromBlockId && br.toBlockId === r.toBlockId)))
    return '本区块存在待修复引用，修复前不能批准';

  const snapshot: Record<string, number> = {};
  snapshot[block.id] = cmd.asOfVersions?.[block.id] ?? latestVersion(block);
  for (const ref of out) {
    const target = blockById(notice, ref.toBlockId)!;
    snapshot[target.id] = cmd.asOfVersions?.[target.id] ?? latestVersion(target);
  }
  const review: Review = {
    id: uid(),
    mode: 'block',
    lang: cmd.lang,
    scopeBlockId: block.id,
    sourceSnapshot: snapshot,
    orderSignature: liveBlocks(notice).map((b) => b.id),
    refSignature: refSignature(out),
    status: 'approved',
    decidedAt: state.virtualNow,
  };
  const priorIdx = notice.reviews.findIndex(
    (r) => r.mode === 'block' && r.scopeBlockId === block.id && r.lang === cmd.lang,
  );
  if (priorIdx >= 0) notice.reviews.splice(priorIdx, 1, review);
  else notice.reviews.push(review);
  revalidateReviews(notice);

  if (cmd.asOfVersions && review.status === 'stale') {
    R(
      'review_late',
      `${LANG_LABEL[cmd.lang]}区块审阅「晚到」：「${kindName(notice, block.id)}」登记的是旧版快照，到达即失效`,
      [`失效原因：${review.staleReason}`, '依赖版本已变化，旧审阅不能复活，须按当前版本重审'],
    );
    return undefined;
  }
  R('review_approved', `${LANG_LABEL[cmd.lang]}区块审阅已批准：「${kindName(notice, block.id)}」`, [
    out.length
      ? `同时绑定依赖区块版本：${out.map((r) => kindName(notice, r.toBlockId)).join('、')}；依赖源文修订将连带令本审阅失效`
      : '该区块无外发引用，可独立理解与沿用',
  ]);
  return undefined;
}

// ---------------------------------------------------------------------------
// 值班负责人：发布 / 撤回
// ---------------------------------------------------------------------------

function hPublish(
  state: NoticeState,
  cmd: Extract<Command, { type: 'Publish' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (isPublishedNow(notice)) return '通知已处于发布状态，不能重复发布';
  const check = releaseCheck(state, notice);
  if (!check.canPublish)
    return `发布完整性校验未通过（${check.issues.length} 项）：\n${check.issues.map((i) => `· [${i.scope}] ${i.detail}`).join('\n')}`;

  const blocks = liveBlocks(notice);
  const pubVersion = (currentPublication(notice)?.version ?? 0) + 1;
  const recipients = targetResidents(state, notice);
  const blockVersions: Record<string, number> = {};
  for (const b of blocks) blockVersions[b.id] = latestVersion(b);
  const pub: Publication = {
    version: pubVersion,
    mode: notice.reviewMode,
    publishedAt: state.virtualNow,
    blockVersions,
    order: blocks.map((b) => b.id),
    refSignature: currentRefSignature(notice),
    refs: notice.refs.map((r) => ({ ...r })),
    recipientResidentIds: recipients.map((r) => r.id),
  };
  notice.publications.push(pub);
  notice.status = 'published';
  notice.updatedAt = state.virtualNow;

  // 本地模拟适配器入队（短信桩），不调用真实短信服务
  for (const resident of recipients) {
    state.deliveries.push({
      id: uid(),
      noticeId: notice.id,
      publicationVersion: pubVersion,
      residentId: resident.id,
      lang: resident.preferredLang,
      channel: 'sms_stub',
      status: 'queued',
      queuedAt: state.virtualNow,
      resolveAtReal: ctx.realNow + DELIVERY_DELAY_REAL_MS,
      detail: `本地模拟短信：向${resident.name}（${LANG_LABEL[resident.preferredLang]}）投递发布版 v${pubVersion}`,
    });
  }

  R('notice_published', `通知「${notice.title}」已发布 v${pubVersion}（${notice.reviewMode === 'whole' ? '整份审阅' : '区块审阅'}组合）`, [
    `发布版固定区块源文版本、顺序、引用与投递名单（${recipients.length} 名在住对象）`,
    `已通过本地模拟适配器入队 ${recipients.length} 条短信桩投递（约 ${DELIVERY_DELAY_REAL_MS / 1000} 秒后标记送达），不调用真实短信服务`,
    '注意：发布数量 ≠ 实际收悉人数；须等待住户逐人确认知悉，收悉缺口另行统计',
  ]);
  return undefined;
}

function hWithdraw(
  state: NoticeState,
  cmd: Extract<Command, { type: 'Withdraw' }>,
  R: ReceiptSink,
): string | undefined {
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';
  if (!isPublishedNow(notice)) return '仅已发布且未撤回的通知可撤回';
  const pub = currentPublication(notice)!;
  pub.withdrawnAt = state.virtualNow;
  notice.status = 'withdrawn';
  notice.updatedAt = state.virtualNow;
  R('notice_withdrawn', `通知「${notice.title}」v${pub.version} 已撤回`, [
    '居民入口不再展示该通知；撤回后住户才点击的确认将被拒绝并单独留痕，不计入收悉',
    '撤回前已记录的收悉/协助回复原样保留，可按发布版本追溯出处',
  ]);
  return undefined;
}

// ---------------------------------------------------------------------------
// 住户：确认知悉 / 请求协助
// ---------------------------------------------------------------------------

function hResidentAck(
  state: NoticeState,
  cmd: Extract<Command, { type: 'ResidentAck' }>,
  R: ReceiptSink,
): string | undefined {
  const resident = residentById(state, cmd.residentId);
  if (!resident) return '住户不存在';
  const notice = getNotice(state, cmd.noticeId);
  if (!notice) return '通知不存在';

  const reject = (reason: string): string => {
    const pub = currentPublication(notice);
    const rec: RejectedClick = {
      id: uid(),
      residentId: resident.id,
      noticeId: notice.id,
      publicationVersion: pub?.version ?? 0,
      at: state.virtualNow,
      reason,
    };
    state.rejectedClicks.push(rec);
    R('ack_rejected', `${resident.name} 的确认被拒绝：${reason}`, ['该次点击已留痕，但不计入收悉统计']);
    return reason;
  };

  if (resident.status === 'moved_out')
    return reject('该家庭已迁出，不再接收新安排（此前回复仍保留出处）');
  if (!isPublishedNow(notice))
    return reject('通知已撤回或尚未发布，当前为无效安排，确认不予记录');
  const pub = currentPublication(notice)!;
  if (!pub.recipientResidentIds.includes(resident.id))
    return reject('您不在该通知的投递名单内');

  const dup = state.acknowledgements.find(
    (a) => a.residentId === resident.id && a.noticeId === notice.id && a.publicationVersion === pub.version,
  );
  if (dup) {
    R(
      'ack_duplicate',
      `${resident.name} 对 v${pub.version} 的重复确认已幂等忽略`,
      ['同一发布版本在两个标签页重复确认仅记一次；较早的确认仍为唯一有效记录'],
      { duplicateOf: dup.id },
    );
    return undefined;
  }

  const ack: Acknowledgement = {
    id: uid(),
    residentId: resident.id,
    noticeId: notice.id,
    publicationVersion: pub.version,
    kind: cmd.kind,
    noticeStatusAtClick: 'published',
    residentStatusAtClick: resident.status,
    assistNote: cmd.kind === 'assist' ? cmd.assistNote?.trim() || '住户请求协助，请值班负责人联系' : undefined,
    at: state.virtualNow,
  };
  state.acknowledgements.push(ack);
  if (cmd.kind === 'assist') {
    R(
      'assist_submitted',
      `${resident.name} 对「${notice.title}」v${pub.version} 提交协助请求`,
      [ack.assistNote ?? '', '已进入协助待办，收悉统计中该住户记为已回应（协助），与普通知悉区分'],
    );
  } else {
    R('ack_recorded', `${resident.name} 已确认知悉「${notice.title}」v${pub.version}`, [
      '确认绑定具体发布版本；通知再发布新版本后，旧确认不会自动算作知悉新内容',
    ]);
  }
  return undefined;
}

function hMoveOut(
  state: NoticeState,
  cmd: Extract<Command, { type: 'MoveOutFamily' }>,
  R: ReceiptSink,
): string | undefined {
  const family = state.families.find((f) => f.id === cmd.familyId);
  if (!family) return '家庭不存在';
  const members = state.residents.filter((r) => r.familyId === family.id);
  if (members.every((m) => m.status === 'moved_out')) return '该家庭已全部迁出';
  let n = 0;
  for (const m of members) {
    if (m.status === 'living') {
      m.status = 'moved_out';
      m.movedOutAt = state.virtualNow;
      n++;
    }
  }
  R('family_moved_out', `家庭「${family.name}」已迁出（${n} 人）`, [
    '此后新发布的安排不再向其投递（投递名单按在住对象生成）',
    '该家庭此前的收悉/协助回复原样保留，仍可按发布版本追溯出处',
  ]);
  return undefined;
}

function hAdvance(
  state: NoticeState,
  cmd: Extract<Command, { type: 'AdvanceClock' }>,
  R: ReceiptSink,
): string | undefined {
  if (cmd.toVirtual <= state.virtualNow) return '演示时间只能向前推进';
  state.virtualNow = cmd.toVirtual;
  R('clock_advanced', `演示时间推进至 ${fmtDateTime(cmd.toVirtual)}`);
  return undefined;
}

/** 本地模拟适配器：把到期的排队投递标记为送达 */
function hSweep(state: NoticeState, ctx: CmdCtx, R: ReceiptSink): string | undefined {
  const due = state.deliveries.filter((d) => d.status === 'queued' && d.resolveAtReal <= ctx.realNow);
  for (const d of due) {
    d.status = 'delivered';
    d.deliveredAt = ctx.realNow;
    d.detail = `${d.detail}；已由本地模拟适配器标记送达（无真实短信发出）`;
  }
  if (due.length) R('delivery_swept', `模拟投递结算：${due.length} 条标记为送达`, ['仅本地状态演示，不调用真实短信服务']);
  return undefined;
}

// ---------------------------------------------------------------------------
// 不变量核对（UI 工作台实时展示）
// ---------------------------------------------------------------------------

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function checkInvariants(state: NoticeState): InvariantResult[] {
  const results: InvariantResult[] = [];

  // 1. 当前发布中的通知，其发布版必须三语言齐备且审阅有效（不能用缺译补成已批准）
  const badRelease: string[] = [];
  for (const n of state.notices) {
    if (isPublishedNow(n) && !releaseCheck(state, n).canPublish) badRelease.push(n.title);
  }
  results.push({
    name: '发布完整性',
    ok: badRelease.length === 0,
    detail: badRelease.length ? `发布中却不完整：${badRelease.join('、')}` : '所有发布中的通知均满足「全部必需语言 × 全部区块」译文齐备且审阅有效',
  });

  // 2. 同一住户对同一发布版本至多一条收悉记录（重复确认幂等）
  const keyCount = new Map<string, number>();
  for (const a of state.acknowledgements) {
    const k = `${a.residentId}|${a.noticeId}|${a.publicationVersion}`;
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const dup = [...keyCount.entries()].filter(([, c]) => c > 1);
  results.push({
    name: '收悉幂等',
    ok: dup.length === 0,
    detail: dup.length ? `存在重复收悉：${dup.map(([k]) => k).join('、')}` : '同一住户对同一发布版本仅一条收悉/协助记录',
  });

  // 3. 收悉人数不超过投递名单，且收悉绑定的版本真实存在
  const badAck: string[] = [];
  for (const n of state.notices) {
    for (const pub of n.publications) {
      const acks = state.acknowledgements.filter((a) => a.noticeId === n.id && a.publicationVersion === pub.version);
      const ids = new Set(acks.map((a) => a.residentId));
      if (ids.size > pub.recipientResidentIds.length) badAck.push(`${n.title} v${pub.version}`);
      for (const id of ids) if (!pub.recipientResidentIds.includes(id)) badAck.push(`${n.title} v${pub.version} 含名单外住户`);
    }
  }
  results.push({
    name: '收悉口径 ≤ 投递口径',
    ok: badAck.length === 0,
    detail: badAck.length ? badAck.join('；') : '发布数量不等于收悉人数；每条收悉都能回溯到发布版投递名单',
  });

  // 4. 未发布通知允许有待修复引用，但发布中的通知引用必须闭合
  const refBad: string[] = [];
  for (const n of state.notices) {
    if (isPublishedNow(n) && brokenRefs(n).length) refBad.push(n.title);
  }
  results.push({
    name: '引用闭合',
    ok: refBad.length === 0,
    detail: refBad.length ? `发布中存在失效引用：${refBad.join('、')}` : '发布中的通知不存在悬空/残缺引用；删除被引用块会在发布前拦截',
  });

  // 5. 迁出居民不出现在任何新发布版的投递名单中（名单生成之后迁出的历史版本除外）
  const moveBad: string[] = [];
  for (const n of state.notices) {
    const latest = currentPublication(n);
    if (!latest) continue;
    for (const id of latest.recipientResidentIds) {
      const r = state.residents.find((x) => x.id === id);
      if (r && r.status === 'moved_out' && (r.movedOutAt ?? 0) < latest.publishedAt) moveBad.push(r.name);
    }
  }
  results.push({
    name: '迁出不投递',
    ok: moveBad.length === 0,
    detail: moveBad.length ? `迁出后仍进入投递名单：${moveBad.join('、')}` : '迁出家庭不再接收新安排；其历史回复保留出处',
  });

  return results;
}
