/**
 * 领域模型：多语言通知发布与收悉工作台
 *
 * 一条通知（Notice）由若干区块（Block）组成，区块之间可登记引用（如「行动说明」
 * 引用「时间地点」）。源文每次修订产生新版本号；译文按语言独立编辑，译文的有效
 * 性必须同时绑定「源文版本 + 所依赖区块的源文版本」，不能只看译文编辑时间。
 *
 * 审阅有两条路径：
 * - whole 整份审阅：一次审阅整份多语言通知，任一区块源文变更即整份失效，须重审整份；
 * - block 区块审阅：以「区块 × 语言」为单位独立审阅，互不影响的译文可沿用，
 *   但引用失效必须准确传播，发布前检查组合完整可理解。
 */

export type Role = 'receptionist' | 'translator' | 'duty' | 'resident';

/** 演示固定三种必需语言 */
export type Lang = 'zh' | 'en' | 'vi';

export type BlockKind = 'subject' | 'time_place' | 'action';

/** 引用关系：from 区块引用 to 区块（行动说明 → 时间地点） */
export interface BlockRef {
  fromBlockId: string;
  toBlockId: string;
}

export interface BlockVersion {
  /** 单调递增的源文版本号，从 1 开始 */
  version: number;
  text: string;
  /** 该版本生效（修订）时的业务时间 */
  revisedAt: number;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** 显示顺序（支持区块换序） */
  order: number;
  /** 逻辑删除：删除后不再进入发布组合，但被引用时会令引用方进入待修复 */
  deleted: boolean;
  versions: BlockVersion[];
}

export interface TranslationState {
  lang: Lang;
  text: string;
  /** 译文所基于的本区块源文版本（空译文时为 0） */
  basedOnSourceVersion: number;
  editedAt: number;
}

export type ReviewMode = 'whole' | 'block';

export type ReviewStatus = 'pending' | 'approved' | 'stale';

/**
 * 审阅记录。
 * whole 模式：scopeBlockId 为 undefined，覆盖当时整份通知的全部区块；
 * block 模式：scopeBlockId 指向具体区块，只覆盖该区块。
 */
export interface Review {
  id: string;
  mode: ReviewMode;
  lang: Lang;
  scopeBlockId?: string;
  /** 批准时绑定的源文版本快照：block → sourceVersion */
  sourceSnapshot: Record<string, number>;
  /** 批准时绑定的区块顺序（block id 按 order 排列；换序即令整份审阅失效） */
  orderSignature: string[];
  /** 批准时绑定的引用快照：`fromBlockId>toBlockId` 集合 */
  refSignature: string[];
  status: ReviewStatus;
  decidedAt: number;
  /** 失效原因（stale 时填写，供工作台解释） */
  staleReason?: string;
}

export type NoticeStatus = 'draft' | 'published' | 'withdrawn';

export interface Publication {
  /** 发布版本号，从 1 递增；撤回后再发布产生新版本 */
  version: number;
  mode: ReviewMode;
  publishedAt: number;
  withdrawnAt?: number;
  /** 发布时各区块源文版本：block → sourceVersion */
  blockVersions: Record<string, number>;
  /** 发布时通知的区块顺序快照（block id 列表） */
  order: string[];
  refSignature: string[];
  /** 发布时的引用登记快照 */
  refs: BlockRef[];
  /** 本次发布的在住投递对象（发布后迁出不改变该名单，收悉缺口按此名单统计） */
  recipientResidentIds: string[];
}

export interface Notice {
  id: string;
  title: string;
  /** 审阅工作流：whole 整份审阅 / block 区块审阅（创建时确定） */
  reviewMode: ReviewMode;
  /** 投递目标：楼栋（building）或具体家庭（family） */
  targetType: 'building' | 'family';
  targetId: string;
  status: NoticeStatus;
  blocks: Block[];
  refs: BlockRef[];
  translations: Record<string, TranslationState[]>; // blockId -> 每语言一条
  reviews: Review[];
  publications: Publication[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 居民与收悉
// ---------------------------------------------------------------------------

export type ResidentStatus = 'living' | 'moved_out';

export interface Resident {
  id: string;
  name: string;
  buildingId: string;
  familyId: string;
  preferredLang: Lang;
  status: ResidentStatus;
  movedOutAt?: number;
}

export type AcknowledgementKind = 'ack' | 'assist';

export interface Acknowledgement {
  id: string;
  residentId: string;
  noticeId: string;
  /** 针对的发布版本（同一版本在两标签重复确认仅记一次） */
  publicationVersion: number;
  kind: AcknowledgementKind;
  /** 确认时通知状态（withdrawn 后点击会被拒绝并记录尝试，不计入收悉） */
  noticeStatusAtClick: NoticeStatus;
  assistNote?: string;
  at: number;
  /** 确认时居民状态，保留出处（迁出后历史回复仍可追溯） */
  residentStatusAtClick: ResidentStatus;
}

/** 撤回后居民才点击确认：被拒绝的尝试，单独留痕 */
export interface RejectedClick {
  id: string;
  residentId: string;
  noticeId: string;
  publicationVersion: number;
  at: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// 本地模拟投递适配器（不调用真实短信服务）
// ---------------------------------------------------------------------------

export type DeliveryChannel = 'sms_stub' | 'notice_board';
export type DeliveryStatus = 'queued' | 'delivered' | 'failed';

export interface DeliveryRecord {
  id: string;
  noticeId: string;
  publicationVersion: number;
  residentId: string;
  lang: Lang;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  queuedAt: number;
  /** 本地模拟适配器的应送达真实时刻（真实时钟，非虚拟时钟） */
  resolveAtReal: number;
  deliveredAt?: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// 回执与命令
// ---------------------------------------------------------------------------

export interface Receipt {
  seq: number;
  id: string;
  at: number;
  kind: string;
  actor: string;
  summary: string;
  lines: string[];
  /** 重复提交被幂等忽略时，指向原回执 */
  duplicateOf?: string;
}

export interface CommandLogEntry {
  commandId: string;
  at: number;
  ok: boolean;
  summary: string;
  receiptIds: string[];
}

export interface NoticeState {
  version: number;
  /** 演示虚拟时钟（业务时间） */
  virtualNow: number;
  languages: Lang[];
  buildings: { id: string; name: string }[];
  families: { id: string; name: string; buildingId: string }[];
  residents: Resident[];
  notices: Notice[];
  acknowledgements: Acknowledgement[];
  rejectedClicks: RejectedClick[];
  deliveries: DeliveryRecord[];
  receipts: Receipt[];
  commandLog: CommandLogEntry[];
  seqCounter: number;
}

export interface CreateNoticeInput {
  title: string;
  targetType: 'building' | 'family';
  targetId: string;
  /** 初始区块（至少 1 个） */
  blocks: { kind: BlockKind; text: string }[];
  /** 初始引用，按下标表示：[引用方下标, 被引用方下标] */
  refIndices: [number, number][];
}

export type Command =
  | { type: 'CreateNotice'; commandId: string; input: CreateNoticeInput }
  | { type: 'ReviseBlock'; commandId: string; noticeId: string; blockId: string; text: string }
  | { type: 'ReorderBlocks'; commandId: string; noticeId: string; orderedBlockIds: string[] }
  | { type: 'DeleteBlock'; commandId: string; noticeId: string; blockId: string }
  | { type: 'SetBlockRefs'; commandId: string; noticeId: string; refs: BlockRef[] }
  | { type: 'SwitchReviewMode'; commandId: string; noticeId: string; mode: ReviewMode }
  | {
      type: 'SaveTranslation';
      commandId: string;
      noticeId: string;
      blockId: string;
      lang: Lang;
      text: string;
    }
  | {
      type: 'SubmitWholeReview';
      commandId: string;
      noticeId: string;
      lang: Lang;
      approve: boolean;
      /** 模拟「旧审阅晚到」：按指定的旧版快照登记，到达后立即被判定失效 */
      asOfVersions?: Record<string, number>;
    }
  | {
      type: 'SubmitBlockReview';
      commandId: string;
      noticeId: string;
      blockId: string;
      lang: Lang;
      approve: boolean;
      asOfVersions?: Record<string, number>;
    }
  | { type: 'Publish'; commandId: string; noticeId: string }
  | { type: 'Withdraw'; commandId: string; noticeId: string }
  | { type: 'ResidentAck'; commandId: string; residentId: string; noticeId: string; kind: AcknowledgementKind; assistNote?: string }
  | { type: 'MoveOutFamily'; commandId: string; familyId: string }
  | { type: 'AdvanceClock'; commandId: string; toVirtual: number }
  | { type: 'SweepDeliveries'; commandId: string }
  | { type: 'ResetDemo'; commandId: string };

export interface CmdCtx {
  role: Role;
  realNow: number;
}

export interface CmdOutcome {
  state: NoticeState;
  receipts: Receipt[];
  error?: string;
  changed: boolean;
}
