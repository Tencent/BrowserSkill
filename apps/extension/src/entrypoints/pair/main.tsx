import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { PairApp } from "./App";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Pair root is missing");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <PairApp />
    </I18nextProvider>
  </React.StrictMode>,
);
