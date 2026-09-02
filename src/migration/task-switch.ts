import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store.ts";

/**
 * 一次性上线切换（S1，2026-09）。**验证通过后移除**（impl-plan/handover TODO）；
 * 不是长期能力，见 design「上线切换不迁移旧 Session」。
 *
 * Product 语义：缺 Root 时创建 Root（含首个 session）；存在遗留 session
 * （task_id IS NULL）时按 design 直接硬删全部遗留。
 *
 * Dogfood 私有（WEBAGENT_TASK_SWITCH=1）：额外①先做在线快照
 * `db.backup(<dataDir>/webagent.pre-s1.db)`（keep-first，不覆盖），
 * ②把当前 agent 最近活跃的 live session carry 为 Root 下第一个子 Task
 * （title/cwd/model/mode/reasoning 随 session 上移 Task，events/attachments
 * 通过 adoptSession 收养）。
 *
 * 幂等：Root 已存在即 no-op。回滚 = 用快照覆盖 webagent.db 后，tasks 表
 * 无 Root，下次启动自然重跑（无需额外开关）。原子性：写操作全在单事务内；
 * 快照在事务前。
 */
export const TASK_SWITCH_ENV = "WEBAGENT_TASK_SWITCH";
export const TASK_SWITCH_SNAPSHOT = "webagent.pre-s1.db";

export interface TaskSwitchOptions {
  /** dataDir —— 快照写到 <dataDir>/webagent.pre-s1.db */
  dataDir: string;
  /** Root Task 的 cwd（dogfood 配置默认） */
  defaultCwd: string;
  /** 当前 agent cmd（carry 的候选范围） */
  agentKey: string;
  /** 测试可注入 env；默认 process.env */
  env?: NodeJS.ProcessEnv;
}

export interface TaskSwitchResult {
  ran: boolean;
  /** dogfood 模式下被 carry 的 session id（无则 undefined） */
  carriedSessionId?: string;
  /** 本次是否真正创建了快照（keep-first 命中时为 false） */
  snapshotTaken: boolean;
}

export async function runTaskSwitch(
  store: Store,
  opts: TaskSwitchOptions,
): Promise<TaskSwitchResult> {
  if (store.hasRootTask()) return { ran: false, snapshotTaken: false };

  const env = opts.env ?? process.env;
  const dogfood = env[TASK_SWITCH_ENV] === "1";

  const rootId = randomUUID();
  const out: TaskSwitchResult = { ran: true, snapshotTaken: false };

  if (dogfood) {
    const snapshotPath = join(opts.dataDir, TASK_SWITCH_SNAPSHOT);
    if (!existsSync(snapshotPath)) {
      await store.backup(snapshotPath);
      out.snapshotTaken = true;
    }
  }

  store.transaction(() => {
    // Root + 首个 session（唯一的活 Root；Step 3+ 的正常创建也绑定到此 task）
    store.createTask({ id: rootId, name: "root", cwd: opts.defaultCwd });
    const rootSessionId = randomUUID();
    store.createSession(
      rootSessionId,
      opts.defaultCwd,
      "auto",
      rootSessionId,
      rootId,
    );

    if (dogfood) {
      // 当前 agent 的 live sessions（最近活跃在前）；只收养遗留（task_id IS NULL）
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
    }

    // 剩余遗留 session 全部硬删（design：上线切换不迁移旧 Session）
    store.deleteLegacySessions();
  });

  return out;
}
