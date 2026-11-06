"""top100.csv -> keyword_counts.csv. 제목+소개문(dsc)에 트로프 정규식이 1회 이상 맞으면 작품 1편으로 셈. 휴리스틱."""
import csv, re, sys, pathlib, collections
base = pathlib.Path(sys.argv[1])
KW = {
 "회귀": r"회귀|돌아왔|되돌아|다시 시작",
 "환생": r"환생|다시 태어",
 "빙의": r"빙의|책 속|소설 속|게임 속",
 "헌터·게이트·던전": r"헌터|게이트|던전|각성자",
 "상태창·시스템": r"상태창|시스템|레벨|스킬",
 "탑": r"탑",
 "시대(황제·전쟁)": r"황제|전쟁|제국|왕조|조선|삼국|대군",
 "귀족·황실": r"귀족|황실|황제|황녀|황태자|공작|영애|백작|후작|영지|왕자|공주",
 "문파·세력": r"무림|마교|천마|정파|사파|문파|화산|무당|소림|세가|강호",
 "전문직·천재": r"천재|의사|변호사|검사|판사|요리|셰프|의원|교수|회계|작가|PD",
 "연예계": r"연예|배우|아이돌|방송|감독|가수|드라마|영화",
 "스포츠": r"야구|축구|농구|골프|선수|스포츠|메이저리그|리그",
 "재벌·기업": r"재벌|회장|기업|그룹|본부장|사장|대표|상사",
 "육아·가족": r"육아|아이|아기|딸|아들|아빠|엄마|가족|조카|동생",
 "계약·정략결혼·이혼": r"계약|정략|이혼|결혼|남편|아내|약혼",
 "악녀·악역": r"악녀|악역|악당|흑막",
 "복수": r"복수",
}
rows = list(csv.DictReader(open(base / "top100.csv", encoding="utf-8")))
out = []
for cat in ["현판","판타지","무협","로판","로맨스"]:
    c = collections.Counter()
    for r in rows:
        if r["category"] != cat: continue
        text = r["title"] + " " + r["dsc"]
        for k, pat in KW.items():
            if re.search(pat, text): c[k] += 1
    for k, n in c.most_common(): out.append([cat, k, n, KW[k]])
with open(base / "keyword_counts.csv", "w", newline="", encoding="utf-8") as fp:
    w = csv.writer(fp); w.writerow(["category","keyword_group","works","regex"]); w.writerows(out)
for cat in ["현판","판타지","무협","로판","로맨스"]:
    print(cat, [(k,n) for c2,k,n,_ in out if c2==cat][:9])
