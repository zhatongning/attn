use super::confidence::Confidence;
use super::session::{ObservationKind, SessionRow, SessionState, SourceObservation};

pub fn classify_observation(observation: SourceObservation) -> SessionRow {
    let label = observation
        .label
        .clone()
        .unwrap_or_else(|| format!("Codex session {}", observation.session_id));

    let (state, confidence, reason) = match observation.kind {
        ObservationKind::Running => (
            SessionState::Running,
            Confidence::Exact,
            "running signal observed".to_string(),
        ),
        ObservationKind::Idle => (
            SessionState::Idle,
            Confidence::Inferred,
            "no recent activity observed; idle until the next source signal".to_string(),
        ),
        ObservationKind::WaitingForInput => (
            SessionState::WaitingForInput,
            Confidence::Exact,
            "waiting for user input".to_string(),
        ),
        ObservationKind::CompletedImmediate => (
            SessionState::Inspect,
            Confidence::Exact,
            "completed task ready to inspect; open it to mark read".to_string(),
        ),
        ObservationKind::Completed => (
            SessionState::NeedsAttention,
            Confidence::Exact,
            "completed task was opened; keep it quiet during the 30-minute follow-up window".to_string(),
        ),
        ObservationKind::CompletedStale => (
            SessionState::Idle,
            Confidence::Inferred,
            "completed task is no longer recent; idle until the next source signal".to_string(),
        ),
        ObservationKind::Failed => (
            SessionState::Inspect,
            Confidence::Exact,
            "failed task can be manually reviewed and cleared".to_string(),
        ),
        ObservationKind::Stopped => (
            SessionState::Stopped,
            Confidence::Exact,
            "stopped before completion; decide whether to continue, inspect, or dismiss".to_string(),
        ),
        ObservationKind::InsufficientEvidence => (
            SessionState::Unknown,
            Confidence::Unknown,
            "missing source evidence for status classification".to_string(),
        ),
    };

    SessionRow::new(observation.session_id, label, state, confidence)
        .with_agent_name(observation.agent_name)
        .with_thread_source(observation.thread_source)
        .with_parent_session_id(observation.parent_session_id)
        .with_project_name(observation.project_name)
        .with_workspace(observation.workspace_path)
        .with_reason(reason)
        .with_evidence_summary(observation.evidence_summary)
        .with_last_activity_option(observation.last_activity_at)
        .with_jump_target(observation.jump_target)
}

#[cfg(test)]
mod tests {
    use crate::domain::classification::classify_observation;
    use crate::domain::confidence::Confidence;
    use crate::domain::session::{ObservationKind, SessionState, SourceObservation};

    #[test]
    fn classifies_waiting_observation_as_needs_attention_with_exact_confidence() {
        let observation = SourceObservation::new("s1", ObservationKind::WaitingForInput)
            .with_workspace("/repo")
            .with_last_activity("2026-06-02T10:00:00Z");

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::WaitingForInput);
        assert_eq!(row.confidence, Confidence::Exact);
        assert_eq!(row.workspace_path.as_deref(), Some("/repo"));
    }

    #[test]
    fn classifies_idle_observation_as_idle() {
        let observation = SourceObservation::new("s5", ObservationKind::Idle);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Idle);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("no recent activity"));
    }

    #[test]
    fn classifies_missing_evidence_as_unknown_and_keeps_reason() {
        let observation = SourceObservation::new("s2", ObservationKind::InsufficientEvidence);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Unknown);
        assert_eq!(row.confidence, Confidence::Unknown);
        assert!(row.status_reason.contains("missing"));
    }

    #[test]
    fn classifies_immediate_completed_observation_as_inspect() {
        let mut observation = SourceObservation::new("s3", ObservationKind::CompletedImmediate);
        observation.evidence_summary = Some("JSONL task_complete at 2026-06-06T04:24:30.041Z".to_string());

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Inspect);
        assert_eq!(row.confidence, Confidence::Exact);
        assert!(row.status_reason.contains("completed"));
        assert_eq!(
            row.evidence_summary.as_deref(),
            Some("JSONL task_complete at 2026-06-06T04:24:30.041Z")
        );
    }

    #[test]
    fn classifies_completed_observation_as_needing_attention() {
        let observation = SourceObservation::new("s7", ObservationKind::Completed);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::NeedsAttention);
        assert_eq!(row.confidence, Confidence::Exact);
        assert_eq!(
            row.status_reason,
            "completed task was opened; keep it quiet during the 30-minute follow-up window"
        );
    }

    #[test]
    fn classifies_stale_completed_observation_as_idle() {
        let observation = SourceObservation::new("s6", ObservationKind::CompletedStale);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Idle);
        assert_eq!(row.confidence, Confidence::Inferred);
        assert!(row.status_reason.contains("no longer recent"));
    }

    #[test]
    fn classifies_failed_observation_as_inspect() {
        let observation = SourceObservation::new("s4", ObservationKind::Failed);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Inspect);
        assert_eq!(row.confidence, Confidence::Exact);
        assert!(row.status_reason.contains("failed"));
    }

    #[test]
    fn classifies_stopped_observation_as_stopped() {
        let observation = SourceObservation::new("s8", ObservationKind::Stopped);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Stopped);
        assert_eq!(row.confidence, Confidence::Exact);
        assert!(row.status_reason.contains("stopped before completion"));
    }
}
