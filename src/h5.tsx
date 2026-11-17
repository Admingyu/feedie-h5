import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedieApp } from "./Prototype";
import "./h5.css";

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isFullscreen() {
  const webkitDocument = document as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(document.fullscreenElement || webkitDocument.webkitFullscreenElement);
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function H5App() {
  const [fullscreen, setFullscreen] = useState(() => isFullscreen() || isStandaloneDisplay());
  const [showFullscreenHelp, setShowFullscreenHelp] = useState(false);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(isFullscreen() || isStandaloneDisplay());
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);

    // This works only in browsers that permit fullscreen without a user gesture.
    if (!isFullscreen() && typeof document.documentElement.requestFullscreen === "function") {
      void document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
    };
  }, []);

  const enterFullscreen = async () => {
    const root = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };

    try {
      if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: "hide" });
      } else if (root.webkitRequestFullscreen) {
        await root.webkitRequestFullscreen();
      } else {
        setShowFullscreenHelp(true);
      }
    } catch {
      setShowFullscreenHelp(true);
    }
  };

  return <>
    <FeedieApp />
    {!fullscreen && <button className="fullscreen-action" type="button" onClick={enterFullscreen} aria-label="进入全屏显示">
      <span aria-hidden="true">⛶</span>进入全屏
    </button>}
    {showFullscreenHelp && <div className="fullscreen-help-backdrop" role="presentation" onClick={() => setShowFullscreenHelp(false)}>
      <section className="fullscreen-help" role="dialog" aria-modal="true" aria-labelledby="fullscreen-help-title" onClick={event => event.stopPropagation()}>
        <h2 id="fullscreen-help-title">此浏览器不支持网页全屏</h2>
        {isIOS()
          ? <p>在 Safari 点“分享”，选择“添加到主屏幕”，然后从主屏幕图标打开 Feedie，即可隐藏浏览器工具栏。</p>
          : <p>请从浏览器菜单选择“安装应用”或“添加到主屏幕”，再从桌面图标打开。某些浏览器只允许通过此方式隐藏工具栏。</p>}
        <button type="button" onClick={() => setShowFullscreenHelp(false)}>知道了</button>
      </section>
    </div>}
  </>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><H5App /></React.StrictMode>);
