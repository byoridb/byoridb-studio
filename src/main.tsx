import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// The collector is present only when the native shell was started with BYORI_STUDIO_SELFTEST.
// `?selftest` exists on the dev server alone (Chromium values to compare with): the
// condition is a build-time constant, so a production bundle has no such entry.
if (
  "__BYORI_SELFTEST__" in window ||
  (import.meta.env.DEV && new URLSearchParams(location.search).has("selftest"))
)
  void import("./studio/selfTest").then((module) => module.runSelfTest());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
