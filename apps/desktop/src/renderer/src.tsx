import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./life-context.css";
import "./browser.css";
import "./components/ui/ui.css";
import "./agent-panel-layout.css";
import "./components/browser/model-selector.css";
import "./components/window-controls.css";
import "./motion.css";
import "./components/browser/kestrel-sidebar.css";
import "./components/browser/password-overlay.css";
import { App } from "./App";
import { CalculatorOverlay } from "./components/browser/CalculatorOverlay";
import { PasswordOverlay } from "./components/browser/PasswordOverlay";
import { WindowControls } from "./components/WindowControls";

const isPetOverlay =
	new URLSearchParams(location.search).get("petOverlay") === "1";
const isCalculatorOverlay =
	new URLSearchParams(location.search).get("calculatorOverlay") === "1";
const isPasswordOverlay =
	new URLSearchParams(location.search).get("passwordOverlay") === "1";
const root = document.getElementById("root")!;

if (isPetOverlay || isCalculatorOverlay || isPasswordOverlay) {
	document.documentElement.style.background = "transparent";
	document.body.style.background = "transparent";
	root.style.background = "transparent";
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		{isPetOverlay ? null : isCalculatorOverlay ? (
			<CalculatorOverlay />
		) : isPasswordOverlay ? (
			<PasswordOverlay />
		) : (
			<>
				<WindowControls />
				<App />
			</>
		)}
	</React.StrictMode>,
);
