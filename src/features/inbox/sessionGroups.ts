import type { SessionRow, SessionState } from "../../shared/types/session";

export const groupLabels: Record<SessionState, string> = {
  needsAttention: "Needs attention",
  waitingForInput: "Waiting for input",
  inspect: "Ready to inspect",
  running: "Running",
  stopped: "Stopped",
  idle: "Idle",
  unknown: "Unknown",
  dismissable: "Ready to clear",
};

export function groupSessions(rows: SessionRow[]) {
  return rows
    .filter((row) => !row.dismissed)
    .reduce<Record<SessionState, SessionRow[]>>(
      (groups, row) => {
        groups[row.state].push(row);
        return groups;
      },
      {
        needsAttention: [],
        waitingForInput: [],
        inspect: [],
        running: [],
        stopped: [],
        idle: [],
        unknown: [],
        dismissable: [],
      },
    );
}
