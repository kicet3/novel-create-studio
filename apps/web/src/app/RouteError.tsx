import { isRouteErrorResponse, useRouteError } from "react-router";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ButtonLink } from "../components/ui/Button.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { errorMessage } from "../api/client.js";

/** Router errorElement: 404s and render errors. */
export function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  return (
    <main id="main" className="mx-auto max-w-2xl p-6">
      <PageHeader title={notFound ? "페이지를 찾을 수 없습니다" : "화면을 표시하지 못했습니다"} />
      <EmptyState
        icon={notFound ? "?" : "!"}
        title={notFound ? "주소를 확인하세요" : "예상하지 못한 오류가 발생했습니다"}
        description={notFound ? "요청한 화면이 없거나 이동했습니다." : errorMessage(err)}
        actions={<ButtonLink to="/novels">작품 목록으로</ButtonLink>}
      />
    </main>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="페이지를 찾을 수 없습니다" />
      <EmptyState
        icon="?"
        title="주소를 확인하세요"
        description="요청한 화면이 없거나 이동했습니다."
        actions={<ButtonLink to="/novels">작품 목록으로</ButtonLink>}
      />
    </>
  );
}
