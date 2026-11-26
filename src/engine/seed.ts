import type {
  Block,
  BlockRef,
  Lang,
  Notice,
  NoticeState,
  Resident,
  Review,
  TranslationState,
} from './types';

/**
 * 虚构演示数据，严格对应题目示例：
 * - 每条通知三块（① 服务联系人·独立 ② 时间地点·班车 ③ 行动说明·引用②）、三种语言（中/英/越）
 * - 第二块源文已从 09:00 改为 10:00（v1 保留在版本历史里），第三块引用该发车时刻
 * - 两条同构通知分别走「整份审阅」与「区块审阅」，用于对比两条工作流
 * - 区块审阅通知中：第一块各语言审阅保持有效（可沿用），第二、三块旧审阅已失效
 *
 * 全部为虚构数据，仅保存在本浏览器，不调用真实短信服务。
 */
const T0 = new Date('2026-11-26T08:30:00').getTime();
const T_REVISE = new Date('2026-11-26T08:00:00').getTime();
const T_REVIEW = new Date('2026-11-26T07:40:00').getTime();

export const LANGS: Lang[] = ['zh', 'en', 'vi'];

export const BLOCK_B1 = 'blk-1';
export const BLOCK_B2 = 'blk-2';
export const BLOCK_B3 = 'blk-3';
const REFS: BlockRef[] = [{ fromBlockId: BLOCK_B3, toBlockId: BLOCK_B2 }];

function buildBlocks(): Block[] {
  return [
    {
      id: BLOCK_B1,
      kind: 'subject',
      order: 0,
      deleted: false,
      versions: [
        {
          version: 1,
          text: '服务联系人：接待台李老师，电话分机 8001（工作日 8:00-18:00）。',
          revisedAt: new Date('2026-11-26T07:30:00').getTime(),
        },
      ],
    },
    {
      id: BLOCK_B2,
      kind: 'time_place',
      order: 1,
      deleted: false,
      versions: [
        {
          version: 1,
          text: '班车安排：班车 09:00 在 A 楼门口发车，前往安置中心，车程约 20 分钟。',
          revisedAt: new Date('2026-11-26T07:30:00').getTime(),
        },
        {
          version: 2,
          text: '班车安排：班车 10:00 在 A 楼门口发车，前往安置中心，车程约 20 分钟。',
          revisedAt: T_REVISE,
        },
      ],
    },
    {
      id: BLOCK_B3,
      kind: 'action',
      order: 2,
      deleted: false,
      versions: [
        {
          version: 1,
          text: '请携带住户登记卡，按班车发车时刻提前 10 分钟到 A 楼门口集合，发车时刻以「时间地点」区块为准。',
          revisedAt: new Date('2026-11-26T07:30:00').getTime(),
        },
      ],
    },
  ];
}

function tr(lang: Lang, text: string, basedOnSourceVersion: number, editedAt = T_REVIEW): TranslationState {
  return { lang, text, basedOnSourceVersion, editedAt };
}

/** 三语言译文。b2 仅中文已改到 v2，英/越仍停在 v1（含 09:00）；b3 全部停在 v1 */
function buildTranslations(): Record<string, TranslationState[]> {
  return {
    [BLOCK_B1]: [
      tr('zh', '服务联系人：接待台李老师，电话分机 8001（工作日 8:00-18:00）。', 1),
      tr('en', 'Service contact: Ms. Li at the reception desk, extension 8001 (weekdays 8:00-18:00).', 1),
      tr('vi', 'Liên hệ dịch vụ: cô Li tại bàn tiếp tân, máy lẻ 8001 (ngày thường 8:00-18:00).', 1),
    ],
    [BLOCK_B2]: [
      tr('zh', '班车安排：班车 10:00 在 A 楼门口发车，前往安置中心，车程约 20 分钟。', 2, T_REVISE),
      tr('en', 'Shuttle arrangement: the shuttle departs at 09:00 at the gate of Building A for the resettlement center; the ride takes about 20 minutes.', 1),
      tr('vi', 'Sắp xếp xe đưa đón: xe khởi hành lúc 09:00 tại cổng Tòa A, đi đến trung tâm tái định cư, thời gian di chuyển khoảng 20 phút.', 1),
    ],
    [BLOCK_B3]: [
      tr('zh', '请携带住户登记卡，按班车发车时刻提前 10 分钟到 A 楼门口集合，发车时刻以「时间地点」区块为准。', 1),
      tr('en', 'Please bring your resident registration card and gather at the gate of Building A 10 minutes before the shuttle departure; the departure time follows the "Time & Place" section.', 1),
      tr('vi', 'Vui lòng mang thẻ đăng ký cư trú và tập trung tại cổng Tòa A trước giờ xe khởi hành 10 phút; giờ khởi hành theo khối "Thời gian và địa điểm".', 1),
    ],
  };
}

const SNAP_V1: Record<string, number> = { [BLOCK_B1]: 1, [BLOCK_B2]: 1, [BLOCK_B3]: 1 };
const ORDER_V1 = [BLOCK_B1, BLOCK_B2, BLOCK_B3];
const REF_SIG_V1 = [`${BLOCK_B3}>${BLOCK_B2}`];

/**
 * 整份审阅通知：三语言在 v1 时均已批准整份；b2 升 v2 后整份审阅全部失效，
 * 任一区块再改都要重审整份。
 */
function buildWholeReviews(): Review[] {
  return LANGS.map((lang, i) => ({
    id: `rv-w-${lang}`,
    mode: 'whole',
    lang,
    sourceSnapshot: { ...SNAP_V1 },
    orderSignature: [...ORDER_V1],
    refSignature: [...REF_SIG_V1],
    status: 'stale',
    decidedAt: T_REVIEW + i * 60_000,
    staleReason: '区块「时间地点」源文已从 v1 修订到 v2（09:00→10:00），整份审阅须重新审核整份通知',
  }));
}

/**
 * 区块审阅通知：第一块三语言审阅仍有效（源文未变，可沿用）；
 * 第二块因源文升版失效；第三块因依赖的第二块升版而连带失效。
 */
function buildBlockReviews(): Review[] {
  const reviews: Review[] = [];
  for (const lang of LANGS) {
    reviews.push({
      id: `rv-b-${BLOCK_B1}-${lang}`,
      mode: 'block',
      lang,
      scopeBlockId: BLOCK_B1,
      sourceSnapshot: { [BLOCK_B1]: 1 },
      orderSignature: [...ORDER_V1],
      refSignature: [],
      status: 'approved',
      decidedAt: T_REVIEW,
    });
    reviews.push({
      id: `rv-b-${BLOCK_B2}-${lang}`,
      mode: 'block',
      lang,
      scopeBlockId: BLOCK_B2,
      sourceSnapshot: { [BLOCK_B2]: 1 },
      orderSignature: [...ORDER_V1],
      refSignature: [],
      status: 'stale',
      decidedAt: T_REVIEW,
      staleReason: '本区块源文已从 v1 修订到 v2（09:00→10:00），须依据新版源文重译重审',
    });
    reviews.push({
      id: `rv-b-${BLOCK_B3}-${lang}`,
      mode: 'block',
      lang,
      scopeBlockId: BLOCK_B3,
      // 区块审阅同时快照本区块与所依赖区块（b2）的源文版本
      sourceSnapshot: { [BLOCK_B3]: 1, [BLOCK_B2]: 1 },
      orderSignature: [...ORDER_V1],
      refSignature: [...REF_SIG_V1],
      status: 'stale',
      decidedAt: T_REVIEW,
      staleReason: '本区块引用的「时间地点」已从 v1 修订到 v2，引用内容失效，须核对新时刻后重审',
    });
  }
  return reviews;
}

function buildNotice(id: string, title: string, mode: 'whole' | 'block', reviews: Review[]): Notice {
  return {
    id,
    title,
    reviewMode: mode,
    targetType: 'building',
    targetId: 'bld-A',
    status: 'draft',
    blocks: buildBlocks(),
    refs: REFS.map((r) => ({ ...r })),
    translations: buildTranslations(),
    reviews,
    publications: [],
    createdAt: new Date('2026-11-26T07:30:00').getTime(),
    updatedAt: T_REVISE,
  };
}

function buildResidents(): Resident[] {
  return [
    { id: 'res-wang', name: '王芳', buildingId: 'bld-A', familyId: 'fam-1', preferredLang: 'zh', status: 'living' },
    { id: 'res-wangxm', name: '王小明', buildingId: 'bld-A', familyId: 'fam-1', preferredLang: 'zh', status: 'living' },
    { id: 'res-li', name: '李强', buildingId: 'bld-A', familyId: 'fam-2', preferredLang: 'zh', status: 'living' },
    { id: 'res-lisa', name: 'Lisa Li', buildingId: 'bld-A', familyId: 'fam-2', preferredLang: 'en', status: 'living' },
    { id: 'res-tran', name: 'Trần Văn', buildingId: 'bld-B', familyId: 'fam-3', preferredLang: 'vi', status: 'living' },
    { id: 'res-nguyen', name: 'Nguyễn Thị', buildingId: 'bld-B', familyId: 'fam-3', preferredLang: 'en', status: 'living' },
  ];
}

export function seedState(): NoticeState {
  const noticeWhole = buildNotice('notice-whole', '【整份审阅】班车安排调整通知', 'whole', buildWholeReviews());
  const noticeBlock = buildNotice('notice-block', '【区块审阅】班车安排调整通知', 'block', buildBlockReviews());
  return {
    version: 1,
    virtualNow: T0,
    languages: LANGS,
    buildings: [
      { id: 'bld-A', name: 'A 楼' },
      { id: 'bld-B', name: 'B 楼' },
    ],
    families: [
      { id: 'fam-1', name: '王芳一家', buildingId: 'bld-A' },
      { id: 'fam-2', name: '李强一家', buildingId: 'bld-A' },
      { id: 'fam-3', name: 'Trần 家庭', buildingId: 'bld-B' },
    ],
    residents: buildResidents(),
    notices: [noticeWhole, noticeBlock],
    acknowledgements: [],
    rejectedClicks: [],
    deliveries: [],
    receipts: [
      {
        seq: 1,
        id: 'R1',
        at: T0,
        kind: 'seed',
        actor: '系统',
        summary: '演示数据已就绪（虚构楼栋、家庭与通知，全部数据仅保存在本浏览器）',
        lines: [
          '两条同构通知各含三块、三种语言：① 服务联系人（独立）② 时间地点（班车 09:00 已改为 10:00）③ 行动说明（引用②的发车时刻）',
          '「整份审阅」通知：三语言旧的整份审阅均已失效，须重审整份',
          '「区块审阅」通知：第一块审阅仍有效可沿用，仅第二、三块须重审',
          '通知投递走本地模拟适配器（短信桩 + 公告栏），不调用真实短信服务',
        ],
      },
    ],
    commandLog: [],
    seqCounter: 1,
  };
}
