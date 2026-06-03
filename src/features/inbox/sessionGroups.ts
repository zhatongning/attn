import type { SessionRow, SessionState } from "../../shared/types/session";

export const groupLabels: Record<SessionState, string> = {
  needsAttention: "Needs attention",
  running: "Running",
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
        running: [],
        unknown: [],
        dismissable: [],
      },
    );
}
