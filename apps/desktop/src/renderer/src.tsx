import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./life-context.css";
import "./browser.css";
import "./components/ui/ui.css";
import "./agent-panel-layout.css";
import { App } from "./App";
import { PetOverlay } from "./components/PetOverlay";

const isPetOverlay =
	new URLSearchParams(location.search).get("petOverlay") === "1";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{isPetOverlay ? <PetOverlay /> : <App />}
	</React.StrictMode>,
);
