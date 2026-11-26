import type {
  Block,
  BlockKind,
  BlockRef,
  Lang,
  Notice,
  NoticeState,
  Publication,
  Resident,
  Review,
  Role,
  TranslationState,
} from './types';

export const ROLE_LABEL: Record<Role, string> = {
  receptionist: '接待员',
  translator: '翻译志愿者',
  duty: '值班负责人',
  resident: '住户',
};

export const LANG_LABEL: Record<Lang, string> = {
  zh: '中文',
  en: 'English',
  vi: 'Tiếng Việt',
};

export const BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  subject: '主题 / 服务联系人',
  time_place: '时间地点',
  action: '行动说明',
};

// ---------------------------------------------------------------------------
// 区块与版本
// ---------------------------------------------------------------------------

export function noticeById(state: NoticeState, id: string): Notice | undefined {
  return state.notices.find((n) => n.id === id);
}

export function blockById(notice: Notice, blockId: string): Block | undefined {
  return notice.blocks.find((b) => b.id === blockId);
}

export function liveBlocks(notice: Notice): Block[] {
  return notice.blocks.filter((b) => !b.deleted).sort((a, b) => a.order - b.order);
}

export function latestVersion(block: Block): number {
  return block.versions.reduce((m, v) => Math.max(m, v.version), 0);
}

export function currentSourceText(block: Block): string {
  return [...block.versions].sort((a, b) => b.version - a.version)[0]?.text ?? '';
}

export function sourceTextAt(block: Block, version: number): string {
  return block.versions.find((v) => v.version === version)?.text ?? '';
}

// ---------------------------------------------------------------------------
// 引用
// ---------------------------------------------------------------------------

export function refSignature(refs: BlockRef[]): string[] {
  return refs.map((r) => `${r.fromBlockId}>${r.toBlockId}`).sort();
}

export function currentRefSignature(notice: Notice): string[] {
  return refSignature(notice.refs);
}

export function outgoingRefs(notice: Notice, blockId: string): BlockRef[] {
  return notice.refs.filter((r) => r.fromBlockId === blockId);
}

export function incomingRefs(notice: Notice, blockId: string): BlockRef[] {
  return notice.refs.filter((r) => r.toBlockId === blockId);
}

/** 失效引用：引用指向已删除或不存在的区块（如删除被引用块后，引用方进入待修复） */
export function brokenRefs(notice: Notice): BlockRef[] {
  return notice.refs.filter((r) => {
    const target = blockById(notice, r.toBlockId);
    const source = blockById(notice, r.fromBlockId);
    return !target || target.deleted || !source || source.deleted;
  });
}

/** 待修复引用所影响的区块（引用方） */
export function blocksWithBrokenRefs(notice: Notice): Set<string> {
  return new Set(brokenRefs(notice).map((r) => r.fromBlockId));
}

// ---------------------------------------------------------------------------
// 译文
// ---------------------------------------------------------------------------

export function translationOf(notice: Notice, blockId: string, lang: Lang): TranslationState | undefined {
  return notice.translations[blockId]?.find((t) => t.lang === lang);
}

/** 译文是否可用于审阅/发布：非空且基于该区块当前源文版本 */
export function translationReady(notice: Notice, blockId: string, lang: Lang): boolean {
  const block = blockById(notice, blockId);
  const t = translationOf(notice, blockId, lang);
  if (!block || !t) return false;
  return t.text.trim().length > 0 && t.basedOnSourceVersion === latestVersion(block);
}

// ---------------------------------------------------------------------------
// 审阅有效性：凭「源文版本 + 依赖版本 + 引用 + 译文基线」判定，不看译文编辑时间
// ---------------------------------------------------------------------------

export interface ReviewState {
  status: 'approved' | 'stale';
  reason?: string;
}

function liveVersionMap(notice: Notice): Record<string, number> {
  const m: Record<string, number> = {};
  for (const b of liveBlocks(notice)) m[b.id] = latestVersion(b);
  return m;
}

export function evaluateReview(notice: Notice, r: Review): ReviewState {
  const currentSig = currentRefSignature(notice);
  const versions = liveVersionMap(notice);

  if (r.mode === 'whole') {
    const liveIdsInOrder = liveBlocks(notice).map((b) => b.id);
    const liveIds = [...liveIdsInOrder].sort();
    const snapIds = Object.keys(r.sourceSnapshot).sort();
    if (JSON.stringify(snapIds) !== JSON.stringify(liveIds))
      return { status: 'stale', reason: '通知区块组成已变化（新增/删除区块），整份审阅不再覆盖当前组合' };
    if (JSON.stringify(r.orderSignature ?? []) !== JSON.stringify(liveIdsInOrder))
      return { status: 'stale', reason: '区块顺序已调整，整份组合与批准时不一致，须重审整份' };
    for (const id of liveIds) {
      if (r.sourceSnapshot[id] !== versions[id])
        return {
          status: 'stale',
          reason: `区块「${blockById(notice, id)?.kind}」源文已从 v${r.sourceSnapshot[id]} 修订到 v${versions[id]}，整份须重审`,
        };
    }
    if (JSON.stringify(r.refSignature) !== JSON.stringify(currentSig))
      return { status: 'stale', reason: '区块间引用关系已变化，整份审阅须重做' };
    for (const id of liveIds) {
      const t = translationOf(notice, id, r.lang);
      if (!t || !t.text.trim() || t.basedOnSourceVersion !== r.sourceSnapshot[id])
        return { status: 'stale', reason: '译文缺失或未基于批准时的源文版本，整份审阅失效' };
    }
    return { status: 'approved' };
  }

  // block 审阅
  const block = blockById(notice, r.scopeBlockId!);
  if (!block || block.deleted) return { status: 'stale', reason: '被审阅区块已删除' };
  const own = r.sourceSnapshot[block.id];
  if (own === undefined || own !== latestVersion(block))
    return { status: 'stale', reason: `本区块源文已修订（批准基于 v${own ?? '?'}，当前 v${latestVersion(block)}）` };
  const outSig = refSignature(outgoingRefs(notice, block.id));
  if (JSON.stringify(r.refSignature) !== JSON.stringify(outSig))
    return { status: 'stale', reason: '本区块的引用关系已变化（引用被新增、删除或改指）' };
  for (const ref of outgoingRefs(notice, block.id)) {
    const target = blockById(notice, ref.toBlockId);
    if (!target || target.deleted)
      return { status: 'stale', reason: `引用的区块已删除，引用待修复（不能发布残缺指示）` };
    const depSnap = r.sourceSnapshot[ref.toBlockId];
    if (depSnap === undefined)
      return { status: 'stale', reason: '批准快照未绑定依赖区块版本，无法确认引用内容仍然有效' };
    if (depSnap !== latestVersion(target))
      return {
        status: 'stale',
        reason: `引用的「${BLOCK_KIND_LABEL[target.kind]}」源文已从 v${depSnap} 修订到 v${latestVersion(target)}，依赖内容失效，须核对后重审`,
      };
  }
  const t = translationOf(notice, block.id, r.lang);
  if (!t || !t.text.trim() || t.basedOnSourceVersion !== own)
    return { status: 'stale', reason: '译文缺失或未基于批准时的源文版本' };
  return { status: 'approved' };
}

/** 重新计算全部审阅状态（每次结构/译文变更后调用；版本单调，失效不可凭时间自行恢复） */
export function revalidateReviews(notice: Notice): void {
  for (const r of notice.reviews) {
    const s = evaluateReview(notice, r);
    r.status = s.status;
    r.staleReason = s.reason;
  }
}

export function wholeReviewOf(notice: Notice, lang: Lang): Review | undefined {
  return notice.reviews.find((r) => r.mode === 'whole' && r.lang === lang);
}

export function blockReviewOf(notice: Notice, blockId: string, lang: Lang): Review | undefined {
  return notice.reviews.find((r) => r.mode === 'block' && r.scopeBlockId === blockId && r.lang === lang);
}

export function wholeReviewStatus(notice: Notice, lang: Lang): ReviewState {
  const r = wholeReviewOf(notice, lang);
  if (!r) return { status: 'stale', reason: '尚未提交整份审阅' };
  return evaluateReview(notice, r);
}

export function blockReviewStatus(notice: Notice, blockId: string, lang: Lang): ReviewState {
  const r = blockReviewOf(notice, blockId, lang);
  if (!r) return { status: 'stale', reason: '尚未审阅' };
  return evaluateReview(notice, r);
}

// ---------------------------------------------------------------------------
// 发布完整性：两条路径都要求所有必需语言 × 全部区块齐备且获批，缺一不可
// ---------------------------------------------------------------------------

export interface ReleaseIssue {
  scope: string;
  detail: string;
}

export interface ReleaseCheck {
  canPublish: boolean;
  issues: ReleaseIssue[];
  /** 每语言的齐备进度，供工作台展示 */
  perLang: Record<Lang, { translated: number; approved: number; total: number }>;
}

export function releaseCheck(state: NoticeState, notice: Notice): ReleaseCheck {
  const issues: ReleaseIssue[] = [];
  const blocks = liveBlocks(notice);
  const langs = state.languages;
  const perLang = {} as ReleaseCheck['perLang'];

  if (blocks.length === 0) issues.push({ scope: '组合', detail: '通知没有任何有效区块，不能发布' });
  // 顺序连续性（区块换序后仍须完整可理解）
  const orders = blocks.map((b) => b.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i))
    issues.push({ scope: '组合', detail: '区块顺序不连续，发布前须重新整理顺序' });
  // 失效引用
  for (const ref of brokenRefs(notice)) {
    const from = blockById(notice, ref.fromBlockId);
    issues.push({
      scope: '引用',
      detail: `区块「${from ? BLOCK_KIND_LABEL[from.kind] : ref.fromBlockId}」存在待修复引用：引用了已删除区块，须先修复引用，不能发布残缺指示`,
    });
  }

  for (const lang of langs) {
    let translated = 0;
    let approved = 0;
    for (const block of blocks) {
      if (translationReady(notice, block.id, lang)) translated++;
      else {
        const t = translationOf(notice, block.id, lang);
        const reason =
          !t || !t.text.trim()
            ? '缺译文，不能以缺译文本补成已批准'
            : `译文基于 v${t.basedOnSourceVersion}，当前源文为 v${latestVersion(block)}，须更新译文`;
        issues.push({ scope: `${LANG_LABEL[lang]}译文`, detail: `「${BLOCK_KIND_LABEL[block.kind]}」：${reason}` });
      }
      if (notice.reviewMode === 'whole') {
        if (wholeReviewStatus(notice, lang).status === 'approved') approved++;
      } else {
        if (blockReviewStatus(notice, block.id, lang).status === 'approved') approved++;
      }
    }
    if (notice.reviewMode === 'whole') {
      const st = wholeReviewStatus(notice, lang);
      if (st.status !== 'approved')
        issues.push({ scope: `${LANG_LABEL[lang]}审阅`, detail: st.reason ?? '整份审阅未获批' });
      approved = st.status === 'approved' ? blocks.length : 0;
    } else {
      const stale = blocks.filter((b) => blockReviewStatus(notice, b.id, lang).status !== 'approved');
      if (stale.length)
        issues.push({
          scope: `${LANG_LABEL[lang]}审阅`,
          detail: `${stale.length} 个区块审阅未生效：${stale.map((b) => BLOCK_KIND_LABEL[b.kind]).join('、')}`,
        });
    }
    perLang[lang] = { translated, approved, total: blocks.length };
  }
  return { canPublish: issues.length === 0, issues, perLang };
}

// ---------------------------------------------------------------------------
// 发布与收悉
// ---------------------------------------------------------------------------

export function currentPublication(notice: Notice): Publication | undefined {
  return [...notice.publications].sort((a, b) => b.version - a.version)[0];
}

export function isPublishedNow(notice: Notice): boolean {
  return notice.status === 'published' && !!currentPublication(notice) && !currentPublication(notice)?.withdrawnAt;
}

/** 当前仍在住的投递对象（楼栋=楼内在住居民；家庭=该家庭在住成员） */
export function targetResidents(state: NoticeState, notice: Notice): Resident[] {
  return state.residents.filter((r) => {
    if (r.status !== 'living') return false;
    if (notice.targetType === 'family') return r.familyId === notice.targetId;
    return r.buildingId === notice.targetId;
  });
}

export interface AckStats {
  recipients: number;
  ackedCount: number;
  gapCount: number;
  assistCount: number;
  gapResidents: Resident[];
  ackedResidentIds: Set<string>;
}

export function publicationAckStats(state: NoticeState, notice: Notice, pub: Publication): AckStats {
  const acks = state.acknowledgements.filter(
    (a) => a.noticeId === notice.id && a.publicationVersion === pub.version,
  );
  const ackedResidentIds = new Set(acks.map((a) => a.residentId));
  const recipients = pub.recipientResidentIds
    .map((id) => state.residents.find((r) => r.id === id))
    .filter((r): r is Resident => !!r);
  const gapResidents = recipients.filter((r) => !ackedResidentIds.has(r.id));
  const assistCount = acks.filter((a) => a.kind === 'assist').length;
  return {
    recipients: recipients.length,
    ackedCount: ackedResidentIds.size,
    gapCount: gapResidents.length,
    assistCount,
    gapResidents,
    ackedResidentIds,
  };
}

export function residentById(state: NoticeState, id: string): Resident | undefined {
  return state.residents.find((r) => r.id === id);
}

/** 住户视角：当前可见的有效通知（已发布且未撤回，且本人属于投递对象） */
export function visibleNoticesFor(state: NoticeState, resident: Resident): Notice[] {
  return state.notices.filter((n) => {
    if (!isPublishedNow(n)) return false;
    if (n.targetType === 'family') return n.targetId === resident.familyId;
    return n.targetId === resident.buildingId;
  });
}

export function hasAcked(state: NoticeState, residentId: string, noticeId: string, pubVersion: number): boolean {
  return state.acknowledgements.some(
    (a) => a.residentId === residentId && a.noticeId === noticeId && a.publicationVersion === pubVersion,
  );
}
