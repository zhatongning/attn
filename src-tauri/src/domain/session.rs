use serde::{Deserialize, Serialize};

use super::confidence::Confidence;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObservationKind {
    Running,
    Idle,
    WaitingForInput,
    CompletedImmediate,
    Completed,
    CompletedStale,
    Failed,
    InsufficientEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    NeedsAttention,
    WaitingForInput,
    Inspect,
    Running,
    Idle,
    Unknown,
    Dismissable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JumpAvailability {
    Exact,
    Approximate,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JumpTarget {
    Desktop,
    Cli,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceObservation {
    pub session_id: String,
    pub kind: ObservationKind,
    pub label: Option<String>,
    pub agent_name: Option<String>,
    pub project_name: Option<String>,
    pub workspace_path: Option<String>,
    pub last_activity_at: Option<String>,
    pub evidence_summary: Option<String>,
    pub jump_target: JumpTarget,
}

impl SourceObservation {
    pub fn new(session_id: impl Into<String>, kind: ObservationKind) -> Self {
        Self {
            session_id: session_id.into(),
            kind,
            label: None,
            agent_name: None,
            project_name: None,
            workspace_path: None,
            last_activity_at: None,
            evidence_summary: None,
            jump_target: JumpTarget::Unknown,
        }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn with_agent_name(mut self, agent_name: impl Into<String>) -> Self {
        self.agent_name = Some(agent_name.into());
        self
    }

    pub fn with_project_name(mut self, project_name: impl Into<String>) -> Self {
        self.project_name = Some(project_name.into());
        self
    }

    pub fn with_workspace(mut self, workspace_path: impl Into<String>) -> Self {
        self.workspace_path = Some(workspace_path.into());
        self
    }

    pub fn with_last_activity(mut self, last_activity_at: impl Into<String>) -> Self {
        self.last_activity_at = Some(last_activity_at.into());
        self
    }

    pub fn with_jump_target(mut self, jump_target: JumpTarget) -> Self {
        self.jump_target = jump_target;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_id: String,
    pub label: String,
    pub agent_name: Option<String>,
    pub project_name: Option<String>,
    pub state: SessionState,
    pub confidence: Confidence,
    pub workspace_path: Option<String>,
    pub last_activity_at: Option<String>,
    pub evidence_summary: Option<String>,
    pub status_reason: String,
    pub dismissability_reason: Option<String>,
    pub handled: bool,
    pub dismissed: bool,
    pub jump_availability: JumpAvailability,
    pub jump_target: JumpTarget,
}

impl SessionRow {
    pub fn new(
        session_id: impl Into<String>,
        label: impl Into<String>,
        state: SessionState,
        confidence: Confidence,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            label: label.into(),
            agent_name: None,
            project_name: None,
            state,
            confidence,
            workspace_path: None,
            last_activity_at: None,
            evidence_summary: None,
            status_reason: String::new(),
            dismissability_reason: None,
            handled: false,
            dismissed: false,
            jump_availability: JumpAvailability::Unavailable,
            jump_target: JumpTarget::Unknown,
        }
    }

    pub fn with_agent_name(mut self, agent_name: Option<String>) -> Self {
        self.agent_name = agent_name.filter(|value| !value.is_empty());
        self
    }

    pub fn with_project_name(mut self, project_name: Option<String>) -> Self {
        self.project_name = project_name.filter(|value| !value.is_empty());
        self
    }

    pub fn with_workspace(mut self, workspace_path: Option<String>) -> Self {
        self.workspace_path = workspace_path;
        self
    }

    pub fn with_last_activity(mut self, last_activity_at: impl Into<String>) -> Self {
        self.last_activity_at = Some(last_activity_at.into());
        self
    }

    pub fn with_last_activity_option(mut self, last_activity_at: Option<String>) -> Self {
        self.last_activity_at = last_activity_at.filter(|value| !value.is_empty());
        self
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.status_reason = reason.into();
        self
    }

    pub fn with_evidence_summary(mut self, evidence_summary: Option<String>) -> Self {
        self.evidence_summary = evidence_summary.filter(|value| !value.is_empty());
        self
    }

    pub fn with_dismissability_reason(mut self, reason: Option<String>) -> Self {
        self.dismissability_reason = reason;
        self
    }

    pub fn with_jump_availability(mut self, jump_availability: JumpAvailability) -> Self {
        self.jump_availability = jump_availability;
        self
    }

    pub fn with_jump_target(mut self, jump_target: JumpTarget) -> Self {
        self.jump_target = jump_target;
        self
    }

    pub fn mark_dismissed(mut self) -> Self {
        self.handled = true;
        self.dismissed = true;
        self
    }

    pub fn mark_restored(mut self) -> Self {
        self.handled = false;
        self.dismissed = false;
        self
    }
}
