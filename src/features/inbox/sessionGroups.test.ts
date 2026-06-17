import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types/session";
import { groupSessions } from "./sessionGroups";

const baseRow: SessionRow = {
  sessionId: "s1",
  label: "Task",
  state: "needsAttention",
  confidence: "exact",
  statusReason: "waiting",
  handled: false,
  dismissed: false,
  pinned: false,
  jumpAvailability: "exact",
  jumpTarget: "desktop",
};

describe("groupSessions", () => {
  it("groups visible sessions by state and excludes dismissed rows", () => {
    const groups = groupSessions([
      baseRow,
      { ...baseRow, sessionId: "s0", state: "waitingForInput" },
      { ...baseRow, sessionId: "s2", state: "unknown" },
      { ...baseRow, sessionId: "s3", state: "dismissable" },
      { ...baseRow, sessionId: "s6", state: "stopped" },
      { ...baseRow, sessionId: "s4", state: "idle" },
      { ...baseRow, sessionId: "s5", state: "running", dismissed: true },
    ]);

    expect(groups.needsAttention).toHaveLength(1);
    expect(groups.waitingForInput).toHaveLength(1);
    expect(groups.unknown).toHaveLength(1);
    expect(groups.dismissable).toHaveLength(1);
    expect(groups.stopped).toHaveLength(1);
    expect(groups.idle).toHaveLength(1);
    expect(groups.running).toHaveLength(0);
  });
});
