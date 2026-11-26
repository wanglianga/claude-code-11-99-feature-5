import type { Command } from '../engine/types';

/** 去掉 commandId 的命令（由客户端统一生成幂等 ID） */
export type DraftCommand = { [K in Command['type']]: Omit<Extract<Command, { type: K }>, 'commandId'> }[Command['type']];

export type Send = (cmd: DraftCommand) => Promise<boolean>;
