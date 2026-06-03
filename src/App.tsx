import "./App.css";
import { InboxView } from "./features/inbox/InboxView";
import { fakeSourceHealth, initialSessions } from "./features/inbox/fakeSessions";

function App() {
  return <InboxView initialRows={initialSessions} sourceHealth={fakeSourceHealth} />;
}

export default App;
