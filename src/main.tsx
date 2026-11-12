import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// Present only when the native shell was started with BYORI_STUDIO_SELFTEST.
if ("__BYORI_SELFTEST__" in window)
  void import("./studio/selfTest").then((module) => module.runSelfTest());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
