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
        ObservationKind::WaitingForInput => (
            SessionState::NeedsAttention,
            Confidence::Exact,
            "waiting for user input".to_string(),
        ),
        ObservationKind::Completed | ObservationKind::Failed => (
            SessionState::Dismissable,
            Confidence::Exact,
            "completed or failed task can be manually reviewed and cleared".to_string(),
        ),
        ObservationKind::InsufficientEvidence => (
            SessionState::Unknown,
            Confidence::Unknown,
            "missing source evidence for status classification".to_string(),
        ),
    };

    SessionRow::new(observation.session_id, label, state, confidence)
        .with_agent_name(observation.agent_name)
        .with_project_name(observation.project_name)
        .with_workspace(observation.workspace_path)
        .with_reason(reason)
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

        assert_eq!(row.state, SessionState::NeedsAttention);
        assert_eq!(row.confidence, Confidence::Exact);
        assert_eq!(row.workspace_path.as_deref(), Some("/repo"));
    }

    #[test]
    fn classifies_missing_evidence_as_unknown_and_keeps_reason() {
        let observation = SourceObservation::new("s2", ObservationKind::InsufficientEvidence);

        let row = classify_observation(observation);

        assert_eq!(row.state, SessionState::Unknown);
        assert_eq!(row.confidence, Confidence::Unknown);
        assert!(row.status_reason.contains("missing"));
    }
}
