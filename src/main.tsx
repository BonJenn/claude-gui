import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode intentionally disabled: its dev-only double-mount causes
// Tauri child webviews to be created twice and the first one gets
// orphaned (stuck floating over the main window).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
