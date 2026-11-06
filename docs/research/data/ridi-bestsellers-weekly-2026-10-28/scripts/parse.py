"""리디 웹소설 주간 베스트셀러 API 원본(JSON)을 CSV로 정규화하고 하위 분류 분포를 셉니다.
사용: python3 -I scripts/parse.py <폴더>
원본: https://api.ridibooks.com/v2/views/categories/<id>/bestsellers?adult_option=none&period=weekly&platform=web
"""
import sys, json, csv, collections, pathlib
root = pathlib.Path(sys.argv[1])
rows = []
for f in sorted((root / "raw").glob("*.json")):
    cat = f.stem
    d = json.loads(f.read_text(encoding="utf-8"))
    items = d["data"]["view"]["resources"][0]["items"]
    for rank, it in enumerate(items[:100], 1):
        b = it["contents"]["book"]
        subs = [c["name"] for c in b.get("categories", []) if c.get("parent_id")]
        rows.append({"source": cat, "rank": rank, "book_id": b["book_id"],
                     "title": (b.get("serial") or {}).get("title") or b["title"],
                     "author": "/".join(a["name"] for a in b.get("authors", []) if a.get("role") == "author"),
                     "subcategories": "|".join(subs), "adults_only": b.get("adults_only")})
with open(root / "top100.csv", "w", encoding="utf-8", newline="") as fp:
    w = csv.DictWriter(fp, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
for src in sorted({r["source"] for r in rows}):
    rs = [r for r in rows if r["source"] == src]
    c = collections.Counter(s for r in rs for s in r["subcategories"].split("|") if s)
    print(src, "n=", len(rs), "adults_only=", sum(1 for r in rs if r["adults_only"]), dict(c.most_common()))
