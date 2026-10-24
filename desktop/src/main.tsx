import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { QuickEntry } from "./components/QuickEntry";
import { RecorderBar } from "./components/RecorderBar";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

// One bundle, several windows: the label decides which UI to mount.
const label = getCurrentWindow().label;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "quick" ? <QuickEntry /> : label === "recorder" ? <RecorderBar /> : <App />}</React.StrictMode>,
);
