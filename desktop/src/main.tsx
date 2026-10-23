import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { QuickEntry } from "./components/QuickEntry";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

// One bundle, two windows: the label decides which UI to mount.
const isQuick = getCurrentWindow().label === "quick";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isQuick ? <QuickEntry /> : <App />}</React.StrictMode>,
);
