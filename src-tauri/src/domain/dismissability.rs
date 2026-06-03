use serde::{Deserialize, Serialize};

use super::confidence::Confidence;
use super::session::{SessionRow, SessionState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dismissability {
    pub is_dismissable: bool,
    pub reason: String,
}

pub fn evaluate_dismissability(row: &SessionRow) -> Dismissability {
    if matches!(row.state, SessionState::Unknown) || matches!(row.confidence, Confidence::Unknown | Confidence::Unavailable) {
        return Dismissability {
            is_dismissable: false,
            reason: "unknown or unavailable source evidence blocks automatic dismissability".to_string(),
        };
    }

    if matches!(row.state, SessionState::Dismissable) && matches!(row.confidence, Confidence::Exact | Confidence::Inferred) {
        return Dismissability {
            is_dismissable: true,
            reason: "completed low-risk row can be manually dismissed".to_string(),
        };
    }

    Dismissability {
        is_dismissable: false,
        reason: "row is not in a dismissable state".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::confidence::Confidence;
    use crate::domain::dismissability::evaluate_dismissability;
    use crate::domain::session::{SessionRow, SessionState};

    #[test]
    fn marks_completed_exact_rows_dismissable_with_reason() {
        let row = SessionRow::new("s1", "Completed task", SessionState::Dismissable, Confidence::Exact)
            .with_last_activity("2026-06-02T10:00:00Z");

        let result = evaluate_dismissability(&row);

        assert!(result.is_dismissable);
        assert!(result.reason.contains("completed"));
    }

    #[test]
    fn never_marks_unknown_rows_auto_dismissable() {
        let row = SessionRow::new("s2", "Unknown task", SessionState::Unknown, Confidence::Unknown);

        let result = evaluate_dismissability(&row);

        assert!(!result.is_dismissable);
        assert!(result.reason.contains("unknown"));
    }
}
