"""raw/<code>-p<n>.html -> top100.csv (rank, category_code, product_no, title, author, dsc)."""
import csv, html, re, sys, pathlib
base = pathlib.Path(sys.argv[1])
CODES = {"ALL":"전체","201":"로맨스","202":"판타지","203":"미스터리","205":"라이트노벨","206":"무협","207":"로판","208":"현판","209":"BL"}
item = re.compile(r'<h3>.*?productNo=(\d+)" class="NPI=a:content">(.*?)</a></h3>.*?<span class="author">(.*?)</span>.*?<p class="dsc">(.*?)</p>', re.S)
rows = []
for code in CODES:
    rank = 0
    for p in range(1, 6):
        f = base / "raw" / f"{code}-p{p}.html"
        if not f.exists(): continue
        for m in item.finditer(f.read_text(encoding="utf-8")):
            rank += 1
            clean = lambda s: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()
            rows.append([rank, code, CODES[code], m.group(1), clean(m.group(2)), clean(m.group(3)), clean(m.group(4))])
with open(base / "top100.csv", "w", newline="", encoding="utf-8") as fp:
    w = csv.writer(fp); w.writerow(["rank","category_code","category","product_no","title","author","dsc"]); w.writerows(rows)
print(len(rows))
