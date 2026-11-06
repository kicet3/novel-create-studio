/**
 * 설계 추가 0015: salience filter of the entity resolver (pure, deterministic, no LLM).
 *
 * Before an entity candidate or a disambiguation question is made, a surface is classified:
 *  - `pronoun`  그, 그녀, 저 사람 … — never an entity of its own, never asked: coreference (a unique scene participant, or the
 *               resolver agent) or held without a question;
 *  - `address`  선생님, 판정관님, 아저씨 … generic forms of address / titles + 님 — coreference like pronouns (never asked,
 *               never stored as an alias: the same word addresses different people);
 *  - `generic`  화면, 결승전, 관중 … common nouns that are not story entities → ignored outright;
 *  - `generic_hint` 센터, 게이트, 구립 체육관, 관리 기구 … generic place / organization nouns (alone or with a modifier): they
 *               may still point at an established entity, so only a hint for the resolver (which decides; never asked);
 *  - `candidate` anything else (names, specific descriptions) → linker / resolver as usual.
 * Comparison runs on `normalizedKey` (spaces, quotes removed), so "저 사람" and "저사람" are the same.
 */
import type { MentionKind } from "@ncs/shared";
import { normalizedKey } from "../../ontology/index.js";

export type SurfaceClass = "pronoun" | "address" | "generic" | "generic_hint" | "candidate";

const keys = (words: string[]) => new Set(words.map((w) => normalizedKey(w)));

/** personal / demonstrative pronouns and pronoun-like references */
export const KO_PRONOUNS: ReadonlySet<string> = keys([
  "그", "그녀", "그들", "그녀들", "그놈", "그년", "그자", "그분", "그이", "그애", "그녀석", "그 사람", "그 남자", "그 여자", "그 아이",
  "이 사람", "저 사람", "이분", "저분", "이놈", "저놈", "이 녀석", "저 녀석", "이 자", "걔", "쟤", "얘", "얘들", "걔들",
  "이것", "그것", "저것", "이거", "그거", "저거", "이곳", "그곳", "저곳", "여기", "거기", "저기", "이쪽", "그쪽", "저쪽",
  "너", "너희", "너희들", "니", "네", "당신", "당신들", "나", "내", "저", "제", "우리", "우리들", "저희", "자네", "그대", "본인", "자기", "자신", "스스로",
  "누군가", "누구", "아무개", "아무도", "모두", "다들", "녀석", "놈", "상대", "상대방", "둘", "셋", "그쪽 사람",
]);

/** generic forms of address (kinship, job titles + 님) — coreference only */
export const KO_ADDRESS_GENERIC: ReadonlySet<string> = keys([
  "선생님", "선생", "사장님", "사장", "형", "형님", "누나", "누님", "언니", "오빠", "아저씨", "아줌마", "아주머니", "할머니", "할아버지",
  "아가씨", "도련님", "아버지", "어머니", "아빠", "엄마", "선배", "선배님", "후배", "손님", "대표님", "팀장님", "부장님", "과장님",
  "교수님", "박사님", "의사 선생님", "형사님", "기사님", "주인님", "마스터", "회장님", "원장님", "감독님", "코치님", "관장님",
  "판정관님", "심판님", "감독관님", "교관님", "대장님", "단장님", "협회장님", "센터장님", "소장님", "실장님", "반장님", "아드님", "따님",
]);

/** common nouns that are not story entities (objects, time, crowds, generic events) — ignored */
export const KO_COMMON_NOUNS: ReadonlySet<string> = keys([
  "화면", "모니터", "카메라", "휴대폰", "핸드폰", "스마트폰", "전화", "메시지", "문자", "알림", "뉴스", "방송", "영상", "중계", "홀로그램", "상태창", "시스템 창", "메시지 창",
  "시간", "오늘", "내일", "어제", "아침", "점심", "저녁", "밤", "새벽", "순간", "하루", "주말",
  "하늘", "바닥", "벽", "문", "창문", "복도", "계단", "천장", "공기", "바람", "비", "눈",
  "관중", "관중석", "군중", "사람들", "기자", "기자들", "직원", "직원들", "선수들", "아이들", "학생들", "시민", "시민들",
  "점수", "판정", "결과", "기록", "규칙", "경기", "시합", "결승", "결승전", "준결승", "준결승전", "예선", "본선", "라운드", "세트", "1라운드", "2라운드", "3라운드",
  "몸", "손", "발", "얼굴", "눈빛", "목소리", "숨", "심장", "머리",
]);

/** generic place / organization nouns: may point at an established entity → hint for the resolver only */
export const KO_GENERIC_PLACES: ReadonlySet<string> = keys([
  "센터", "게이트", "시스템", "기구", "관리 기구", "협회", "본부", "지부", "체육관", "경기장", "판정소", "병원", "학교", "연구소", "재활 센터",
  "훈련장", "연습장", "회사", "길드", "조직", "정부", "기관", "사무실", "회의실", "대기실", "숙소", "집", "방", "교실", "거리", "도시", "마을",
  "건물", "역", "공원", "식당", "카페", "편의점", "무대", "광장", "던전", "탑", "성", "궁", "궁궐", "시장", "항구",
]);

/** role-noun endings of "<role>님" forms (판정관님, 협회장님, 박사님 …) */
const ROLE_ENDINGS = ["관", "장", "사", "원", "수", "독", "치", "생", "인", "님"];

function suffixHit(key: string, set: ReadonlySet<string>): boolean {
  for (const w of set) if (w.length >= 2 && key.length > w.length && key.endsWith(w)) return true;
  return false;
}

/** class of one surface (see module doc); `zero` mentions are the linker's report-hold path and stay `candidate` */
export function classifySurface(surface: string, mentionKind: MentionKind | string | null | undefined, nonEntityKeys?: ReadonlySet<string>): SurfaceClass {
  if (mentionKind === "zero") return "candidate";
  const key = normalizedKey(surface);
  if (!key) return "pronoun";
  if (mentionKind === "pronoun" || KO_PRONOUNS.has(key)) return "pronoun";
  if (KO_ADDRESS_GENERIC.has(key)) return "address";
  if (key.endsWith("님") && key.length >= 3 && ROLE_ENDINGS.includes(key.slice(-2, -1)) && (mentionKind === "address" || mentionKind === "title" || mentionKind === "descriptive")) return "address";
  if (KO_COMMON_NOUNS.has(key) || nonEntityKeys?.has(key)) return "generic";
  if (KO_GENERIC_PLACES.has(key)) return "generic_hint";
  // modifier + generic noun ("구립 체육관", "재활센터 3층") — a backdrop description unless the resolver says otherwise
  if (mentionKind !== "named" && (suffixHit(key, KO_GENERIC_PLACES) || suffixHit(key, KO_COMMON_NOUNS))) return "generic_hint";
  if (mentionKind === "named" && /\s/.test(surface.trim()) && (suffixHit(key, KO_GENERIC_PLACES) || suffixHit(key, KO_COMMON_NOUNS))) return "generic_hint";
  return "candidate";
}

/** pronouns / generic address forms: resolved only by coreference, never stored as an alias, never asked */
export const isCoreferenceOnly = (c: SurfaceClass): boolean => c === "pronoun" || c === "address";

/** person-like entity types (question wording "누구" instead of "무엇") */
export const PERSON_TYPES: ReadonlySet<string> = new Set(["character", "persona"]);
