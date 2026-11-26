import { openDB, type IDBPDatabase } from 'idb';
import { seedState } from '../engine/seed';
import type { NoticeState } from '../engine/types';

/**
 * IndexedDB 持久化：整份状态为单条记录，所有变更在单个 readwrite 事务内
 * 完成「读取 → 引擎校验 → 写回」。同一站点（origin）下多个标签页共享该库，
 * IndexedDB 会序列化同一 object store 上的 readwrite 事务，因此跨标签的
 * 并发命令（翻译、审阅、发布、确认）天然按事务串行执行、彼此重新核对。
 */
const DB_NAME = 'notice-workbench';
const STORE = 'kv';
const KEY = 'state';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

export async function transact<T>(
  fn: (state: NoticeState) => { state?: NoticeState; out: T },
): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const raw = (await store.get(KEY)) as NoticeState | undefined;
  const result = fn(raw ?? seedState());
  if (result.state) await store.put(result.state, KEY);
  await tx.done;
  return result.out;
}

export async function readState(): Promise<NoticeState> {
  const db = await getDb();
  const raw = (await db.get(STORE, KEY)) as NoticeState | undefined;
  return raw ?? seedState();
}
