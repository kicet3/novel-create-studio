import { Link } from "react-router";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { useNovelId } from "../../app/novel-context.js";
import { ImageStudio } from "./ImageStudio.js";

/** /images — 설치 공용 이미지 생성 탭 */
export function ImagesPage() {
  return (
    <>
      <PageHeader
        title="이미지 생성"
        subtitle="GPT·Grok·Gemini로 이미지를 만듭니다. 작품에 붙일 이미지는 작품 안의 '이미지 생성' 메뉴에서 만드세요."
      />
      <ImageStudio />
    </>
  );
}

/** /novels/:novelId/images — 이 작품 소속 이미지(작품 예산에서 확인·기록) */
export function NovelImagesPage() {
  const novelId = useNovelId();
  return (
    <>
      <PageHeader
        title="이미지 생성"
        subtitle={
          <>
            이 작품에 붙는 이미지입니다. 비용은 작품의 이미지 예산에서 확인하고 기록합니다.{" "}
            <Link to="/images">설치 공용 이미지 보기</Link> · <Link to={novelPath(novelId, "settings")}>예산 설정</Link>
          </>
        }
      />
      <ImageStudio novelId={novelId} />
    </>
  );
}
