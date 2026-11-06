import { useEffect } from "react";

const APP_NAME = "Novel Studio";

/** Sets `document.title` to "<title> · Novel Studio" while the component is mounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
