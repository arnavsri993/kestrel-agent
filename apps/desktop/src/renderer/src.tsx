import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { PetOverlay } from "./components/PetOverlay";

const isPetOverlay = new URLSearchParams(location.search).get("petOverlay") === "1";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isPetOverlay ? <PetOverlay /> : <App />}</React.StrictMode>
);
