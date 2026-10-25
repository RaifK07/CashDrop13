import asyncio
from playwright.async_api import async_playwright
# ... (diğer kütüphaneler ve FastAPI tanımlamaların aynı kalacak)

# Proxy bilgilerin (Playwright formatında)
PROXY_SERVER = "http://geo.iproyal.com:12321"
PROXY_CREDENTIALS = {
    "username": "GVJpiKuCvSEhZb9f",
    "password": "qHDZA1qicLNiWPxi"
}

async def fetch_stock_with_browser(city_id, ref_id, size):
    # Playwright'ı başlatıyoruz
    async with async_playwright() as p:
        # Görünmez (headless) bir Chromium tarayıcı açıyoruz
        # WAF'ı atlatma şansını artırmak için args ekliyoruz
        browser = await p.chromium.launch(
            headless=True,
            proxy={"server": PROXY_SERVER, "username": PROXY_CREDENTIALS["username"], "password": PROXY_CREDENTIALS["password"]},
            args=["--disable-blink-features=AutomationControlled"]
        )
        
        # Gerçek bir kullanıcı gibi davranması için bir bağlam (context) oluşturuyoruz
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        
        page = await context.new_page()
        
        url = "https://www.lcw.com/tr/ajax/Model/GetStoreStockMultiple"
        payload = {
            "ProductSizes": [{"refId": ref_id, "size": size}], 
            "cityId": str(city_id),
            "countyIds": [],
            "Latitude": None, "Longitude": None, "RecaptchaToken": None, "captchaCode": None
        }

        try:
            print(f"[TARAYICI] İl {city_id} için sayfa açılıyor...")
            
            # Burada 'requests.post' yerine, açtığımız sanal tarayıcının sekmesi (page) 
            # üzerinden javascript/fetch ile API'ye istek atıyoruz.
            # Bu yöntem, tarayıcının TLS parmak izini ve çerezlerini kullanacağı için WAF'ı geçme ihtimali daha yüksektir.
            response = await page.request.post(
                url,
                data=payload,
                headers={"Accept": "application/json", "Content-Type": "application/json"}
            )
            
            status = response.status
            if status == 200:
                data = await response.json()
                store_list = data if isinstance(data, list) else data.get("StoreList", [])
                results = []
                for store in store_list:
                    results.append({
                        "storeName": store.get("StoreName", f"LCW Mağaza (İl {city_id})"),
                        "sizes": [{"size": size, "qty": store.get("Quantity", "Var")}]
                    })
                await browser.close()
                return results
            else:
                print(f"[WAF/HATA] İl {city_id} başarısız. Durum Kodu: {status}")
                
        except Exception as e:
            print(f"[HATA] İl {city_id} tarayıcı hatası: {str(e)}")
            
        await browser.close()
        return []

# FastAPI endpointini async yapıyoruz
@app.post("/api/lcw/find-store")
async def find_store(data: FindStoreModel):
    target_ref_id = 22945710 
    target_size = "M"
    all_results = []

    # RAM'i şişirmemek için 81 ili tek tek veya küçük gruplar (semaphore) halinde taramalısın.
    # Şimdilik örnek olarak ilk 3 ili asenkron tarayalım:
    tasks = []
    for city_id in range(1, 4):
        tasks.append(fetch_stock_with_browser(city_id, target_ref_id, target_size))
        
    # Görevleri çalıştır ve bekle
    results_list = await asyncio.gather(*tasks)
    
    for city_results in results_list:
        if city_results:
            for res in city_results:
                all_results.append({
                    "storeName": res["storeName"],
                    "stockCode": data.stockCode,
                    "sizes": res["sizes"]
                })
                
    if not all_results:
        return {"results": [{"storeName": "Stok bulunamadı veya WAF engelledi.", "stockCode": data.stockCode, "sizes": [{"size": "-", "qty": 0}]}]}
        
    return {"results": all_results}
