import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Bundled fonts: the board is a local tool and must work offline, so nothing is loaded from a font CDN.
// The browser only downloads the subsets a page needs (Latin + Latin Extended covers Turkish).
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
