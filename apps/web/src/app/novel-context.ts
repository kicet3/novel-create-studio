import { useParams } from "react-router";

/** `:novelId` of the current `/novels/:novelId/*` route. Throws outside the novel layout. */
export function useNovelId(): string {
  const { novelId } = useParams();
  if (!novelId) throw new Error("useNovelId() used outside /novels/:novelId routes");
  return novelId;
}
