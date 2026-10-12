import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedieApp } from "./Prototype";
import "./h5.css";

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function H5App() {
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement) || isStandaloneDisplay());
  const canRequestFullscreen = typeof document.documentElement.requestFullscreen === "function";

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement) || isStandaloneDisplay());
    document.addEventListener("fullscreenchange", syncFullscreen);

    // Browsers that allow automatic fullscreen can enter here. Most browsers
    // reject this until a user gesture, in which case the control below is shown.
    if (!document.fullscreenElement && canRequestFullscreen) {
      void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }

    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [canRequestFullscreen]);

  const enterFullscreen = () => {
    if (!document.fullscreenElement && canRequestFullscreen) {
      void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
  };

  return <>
    <FeedieApp />
    {!fullscreen && canRequestFullscreen && <button className="fullscreen-action" type="button" onClick={enterFullscreen} aria-label="进入全屏显示">
      <span aria-hidden="true">⛶</span>进入全屏
    </button>}
  </>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><H5App /></React.StrictMode>);
