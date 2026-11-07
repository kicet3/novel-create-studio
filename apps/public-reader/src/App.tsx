import { useEffect, useRef } from "react";
import { LoginSheet } from "./components/LoginSheet.js";
import { Message } from "./components/ui.js";
import { readerVars, useReaderSettings, useTheme } from "./lib/hooks.js";
import { href, Link, parseRoute, useLocation } from "./lib/router.js";
import { SessionProvider, useSession } from "./lib/session.js";
import { Admin } from "./pages/Admin.js";
import { NovelHome } from "./pages/NovelHome.js";
import { NovelList } from "./pages/NovelList.js";
import { EpisodeReader } from "./reader/EpisodeReader.js";

function Routes() {
  const { pathname } = useLocation();
  const r = parseRoute(pathname);
  switch (r.name) {
    case "list":
      return <NovelList />;
    case "novel":
      return <NovelHome slug={r.slug} />;
    case "episode":
      return <EpisodeReader slug={r.slug} episodeNo={r.episodeNo} />;
    case "admin":
      return <Admin />;
    default:
      return (
        <main className="pr-main">
          <Message>페이지를 찾을 수 없습니다.</Message>
          <Link className="pr-btn" to={href.list()}>
            작품 목록으로
          </Link>
        </main>
      );
  }
}

function Shell() {
  const [settings] = useReaderSettings();
  const theme = useTheme(settings);
  const ref = useRef<HTMLDivElement>(null);
  const { available } = useSession();
  // body background follows the theme so overscroll / safe areas match
  useEffect(() => {
    if (ref.current) document.body.style.backgroundColor = getComputedStyle(ref.current).backgroundColor;
    document.documentElement.style.colorScheme = theme === "black" ? "dark" : "light";
  }, [theme]);
  return (
    <div ref={ref} className="reader pr-app" data-reader-theme={theme} style={readerVars(settings)}>
      <Routes />
      {available && <LoginSheet />}
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
