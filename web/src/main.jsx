import React from "react";
import { createRoot } from "react-dom/client";
import App, { TabBoundary } from "./App.jsx";
import "./styles/standalone-ui.css";
import "./app.css";

createRoot(document.getElementById("root")).render(<TabBoundary resetKey="root"><App /></TabBoundary>);
