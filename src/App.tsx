import "./App.css";
import { StatusPanelView } from "./features/statusPanel/StatusPanelView";
import type { SourceHealth } from "./shared/types/session";

const initialSourceHealth: SourceHealth = {
  sourceName: "Codex desktop",
  status: "unknown",
  capabilities: [],
};

function App() {
  return <StatusPanelView initialRows={[]} sourceHealth={initialSourceHealth} />;
}

export default App;
