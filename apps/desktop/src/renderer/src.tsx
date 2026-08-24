import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./life-context.css";
import "./browser.css";
import "./components/ui/ui.css";
import "./agent-panel-layout.css";
import "./components/browser/model-selector.css";
import "./motion.css";
import "./components/browser/kestrel-sidebar.css";
import { App } from "./App";

const isPetOverlay =
	new URLSearchParams(location.search).get("petOverlay") === "1";
const root = document.getElementById("root")!;

if (isPetOverlay) {
	document.documentElement.style.background = "transparent";
	document.body.style.background = "transparent";
	root.style.background = "transparent";
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>{isPetOverlay ? null : <App />}</React.StrictMode>,
);
