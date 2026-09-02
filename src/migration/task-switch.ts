import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store.ts";

/**
 * 一次性上线切换（S1，2026-09）。**验证通过后移除**（impl-plan/handover TODO）；
 * 不是长期能力。
 *
 * 语义（2026-09-02 定案，design 修订）：
 * 1. 无条件在线快照 `db.backup(<dataDir>/webagent.pre-s1.db)`（keep-first：
 *    文件已存在即不覆盖——回滚恢复后重跑时该文件正是未迁移状态）；
 * 2. 单事务：建 Root（含首个 session）→ carry 当前 agent 最近活跃的 live
 *    session 为 Root 首个子 Task（title/cwd/model/mode/reasoning 随 session
 *    上移 Task，events/attachments 经 adoptSession 收养）→ 删除其余遗留
 *    session（task_id IS NULL）。
 *
 * 幂等：Root 已存在即 no-op。回滚 = 用快照覆盖 webagent.db → tasks 表无
 * Root → 下次启动自连重跑。原子性：写操作全在单事务；快照在事务前。
 */
export const TASK_SWITCH_SNAPSHOT = "webagent.pre-s1.db";

export interface TaskSwitchOptions {
  /** dataDir —— 快照写到 <dataDir>/webagent.pre-s1.db */
  dataDir: string;
  /** Root Task 的 cwd */
  defaultCwd: string;
}

export interface TaskSwitchResult {
  ran: boolean;
  /** 被 carry 的 session id（无可用候选时 undefined） */
  carriedSessionId?: string;
  /** 本次是否真正创建了快照（keep-first 命中时为 false） */
  snapshotTaken: boolean;
}

export async function runTaskSwitch(
  store: Store,
  opts: TaskSwitchOptions,
): Promise<TaskSwitchResult> {
  if (store.hasRootTask()) return { ran: false, snapshotTaken: false };

  const out: TaskSwitchResult = { ran: true, snapshotTaken: false };

  // 无条件在线快照（keep-first）：切换前的地基，回滚点。
  const snapshotPath = join(opts.dataDir, TASK_SWITCH_SNAPSHOT);
  if (!existsSync(snapshotPath)) {
    await store.backup(snapshotPath);
    out.snapshotTaken = true;
  }

  store.transaction(() => {
    // Root + 首个 session（唯一的活 Root；正常创建流程也绑定此 task）
    const rootId = randomUUID();
    store.createTask({ id: rootId, name: "root", cwd: opts.defaultCwd });
    const rootSessionId = randomUUID();
    store.createSession(
      rootSessionId,
      opts.defaultCwd,
      "auto",
      rootSessionId,
      rootId,
    );

    // carry 当前 agent 最近活跃的 live session 为 Root 首个 child（延续性）
    const candidate = store.listSessions().find((s) => s.task_id == null);
    if (candidate) {
      const childId = randomUUID();
      store.createTask({
        id: childId,
        parentId: rootId,
        name: candidate.title ?? "carried",
        title: candidate.title,
        cwd: candidate.cwd,
        model: candidate.model,
        mode: candidate.mode,
        reasoningEffort: candidate.reasoning_effort,
      });
      store.adoptSession(candidate.id, childId);
      out.carriedSessionId = candidate.id;
    }

    // 其余遗留 session 全部硬删（design：不迁移旧 Session）
    store.deleteLegacySessions();
  });

  return out;
}
