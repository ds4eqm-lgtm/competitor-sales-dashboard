# -*- coding: utf-8 -*-
"""
매일 자동 실행되는 재고 조회 스크립트 (headless 브라우저 방식)
data/history.json  : 상품별 날짜별 재고 원본 기록
data/report.csv    : 날짜별 판매추정 누적 기록 (대시보드가 이 파일을 읽음)
data/latest.json   : 대시보드가 바로 읽기 쉬운 최신 요약 (스토어별 최근 추정치)

최초 1회만 아래 두 명령을 실행해서 준비해야 함
    pip install playwright
    playwright install chromium
"""

import json
import os
import time
import csv
from datetime import date

from playwright.sync_api import sync_playwright

# ---------------- 추적할 상품 목록 ----------------
# slug: 상품 URL의 smartstore.naver.com/뒤에 나오는 스토어 이름
PRODUCTS = [
    {"store": "새로고침", "slug": "serogochim", "channel": "2sXkKvcjUjDuEbb5ZyIyJ", "product": "8709132931"},
    # {"store": "경쟁사A", "slug": "스토어url이름", "channel": "여기에채널아이디", "product": "여기에상품번호"},
]

REQUEST_DELAY_SEC = 3

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
REPORT_FILE = os.path.join(DATA_DIR, "report.csv")
LATEST_FILE = os.path.join(DATA_DIR, "latest.json")


def extract_total_stock(data):
    total = 0
    found = False

    for group in (data.get("combinationOptions") or []):
        for opt in group.get("options", []):
            qty = opt.get("stockQuantity")
            if qty is not None:
                total += qty
                found = True

    if not found:
        for opt in (data.get("simpleOptions") or []):
            qty = opt.get("stockQuantity")
            if qty is not None:
                total += qty
                found = True

    if not found and data.get("stockQuantity") is not None:
        total = data["stockQuantity"]
        found = True

    return total if found else None


def fetch_stock(browser, channel_id: str, product_no: str, store_slug: str):
    """headless 브라우저로 상품페이지 방문 후 내부 API 주소로 직접 이동해 응답 텍스트를 읽는다. 실패하면 None"""
    page = browser.new_page()

    try:
        # 1단계: 정상 방문처럼 상품페이지부터 열어서 세션 확보
        page.goto(
            f"https://smartstore.naver.com/{store_slug}/products/{product_no}",
            timeout=20000,
            wait_until="domcontentloaded",
        )
        page.wait_for_timeout(2000)

        # 2단계: 내부 API 주소로 직접 이동해서 응답 내용을 바로 읽기 (화면 렌더링에 의존하지 않음)
        api_url = f"https://smartstore.naver.com/i/v2/channels/{channel_id}/products/{product_no}?withWindow=false"
        response = page.goto(api_url, timeout=20000)
        raw_text = response.text()
        try:
            data = json.loads(raw_text)
        except Exception:
            print(f"  [실패] {product_no} - 응답 상태코드 {response.status}, 내용 앞부분: {raw_text[:200]!r}")
            page.close()
            return None
    except Exception as e:
        print(f"  [실패] {product_no} - {e}")
        page.close()
        return None

    page.close()
    return extract_total_stock(data)


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def append_report(rows):
    file_exists = os.path.exists(REPORT_FILE)
    with open(REPORT_FILE, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(["날짜", "스토어", "상품번호", "오늘재고", "어제재고", "판매추정"])
        writer.writerows(rows)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    today = date.today().isoformat()
    history = load_json(HISTORY_FILE, {})
    latest = load_json(LATEST_FILE, {})
    report_rows = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)

        for item in PRODUCTS:
            store = item["store"]
            slug = item["slug"]
            channel = item["channel"]
            product = item["product"]
            key = f"{channel}_{product}"

            print(f"{store} / {product} 확인중...")
            stock = fetch_stock(browser, channel, product, slug)
            if stock is None:
                time.sleep(REQUEST_DELAY_SEC)
                continue

            product_history = history.setdefault(key, {})
            yesterday_stock = None
            for d in sorted(product_history.keys(), reverse=True):
                if d < today:
                    yesterday_stock = product_history[d]
                    break

            product_history[today] = stock

            if yesterday_stock is None:
                est_sold = ""
            else:
                diff = yesterday_stock - stock
                est_sold = diff if diff > 0 else 0

            print(f"  재고 {stock}개 -> 판매추정 {est_sold}")

            report_rows.append([today, store, product, stock, yesterday_stock if yesterday_stock is not None else "", est_sold])
            latest[key] = {
                "store": store,
                "product": product,
                "date": today,
                "stock": stock,
                "estSold": est_sold,
            }
            time.sleep(REQUEST_DELAY_SEC)

        browser.close()

    save_json(HISTORY_FILE, history)
    save_json(LATEST_FILE, latest)
    if report_rows:
        append_report(report_rows)


if __name__ == "__main__":
    main()
