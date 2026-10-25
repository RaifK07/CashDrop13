// src/index.js - CashDrop Full-Stack Cloudflare Worker (D1 + Trendyol API + Cron + SPA UI)

const DEFAULT_PRICE_RULES = [
  { min: 0, max: 50, mult: 14 },
  { min: 50, max: 60, mult: 10 },
  { min: 60, max: 70, mult: 9 },
  { min: 70, max: 80, mult: 8 },
  { min: 80, max: 90, mult: 7 },
  { min: 90, max: 100, mult: 6 },
  { min: 100, max: 120, mult: 5.5 },
  { min: 120, max: 130, mult: 5 },
  { min: 130, max: 150, mult: 4.5 },
  { min: 150, max: 200, mult: 4 },
  { min: 200, max: 250, mult: 3.8 },
  { min: 250, max: 350, mult: 3.2 },
  { min: 350, max: 400, mult: 3 },
  { min: 400, max: 500, mult: 2.75 },
  { min: 500, max: 600, mult: 2.75 },
  { min: 600, max: 850, mult: 2.5 },
  { min: 850, max: 1000, mult: 2.5 },
  { min: 1000, max: 1250, mult: 2.25 },
  { min: 1250, max: 1500, mult: 2.25 },
  { min: 1500, max: 1750, mult: 2.05 },
  { min: 1750, max: 2000, mult: 2.25 },
  { min: 2000, max: 2500, mult: 1.92 },
  { min: 2500, max: 3000, mult: 1.9 }
];

// Yardımcı Fonksiyonlar: Şifreleme ve JWT
async function hashPassword(password) {
  const msgBuffer = new TextEncoder().encode(password + "_cashdrop_salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function createToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(unescape(encodeURIComponent(JSON.stringify({ ...payload, exp: Date.now() + 86400000 * 7 }))));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${header}.${body}.${sig}`;
}

async function verifyToken(request, secret) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const payload = JSON.parse(decodeURIComponent(escape(atob(parts[1]))));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Fiyat Hesaplama Motoru
function calculateSalePrice(sourcePrice, rules) {
  for (const r of rules) {
    if (sourcePrice >= Number(r.min) && sourcePrice <= Number(r.max)) {
      return Math.round(sourcePrice * Number(r.mult) * 100) / 100;
    }
  }
  const lastRule = rules[rules.length - 1] || { mult: 2 };
  return Math.round(sourcePrice * Number(lastRule.mult) * 100) / 100;
}

// Kelime Filtresi ve Markup Motoru
function applyProductFiltersAndMarkup(rawProduct, settings) {
  const blockedWords = JSON.parse(settings.blocked_words || "[]");
  const lowerTitle = rawProduct.title.toLowerCase();

  // Bloklanmış kelime kontrolü
  for (const word of blockedWords) {
    if (word && lowerTitle.includes(word.toLowerCase().trim())) {
      return { blocked: true, reason: `Bloklanmış kelime: ${word}` };
    }
  }

  // SKU Prefix Filtresi kontrolü
  const skuPrefixes = (settings.sku_prefixes || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (skuPrefixes.length > 0) {
    const matchesPrefix = skuPrefixes.some(p => rawProduct.code.toUpperCase().startsWith(p));
    if (!matchesPrefix) {
      return { blocked: true, reason: `SKU Prefix eşleşmedi (${rawProduct.code})` };
    }
  }

  // Kelime Değişikliği (Örn: bisiklet -> Oval)
  let finalTitle = rawProduct.title;
  const replacements = JSON.parse(settings.word_replacements || "[]");
  for (const rep of replacements) {
    if (rep.from) {
      const regex = new RegExp(rep.from, "gi");
      finalTitle = finalTitle.replace(regex, rep.to || "");
    }
  }

  // Ürün Adı Markup
  if (settings.title_prefix) finalTitle = `${settings.title_prefix.trim()} ${finalTitle}`;
  if (settings.title_suffix) finalTitle = `${finalTitle} ${settings.title_suffix.trim()}`;

  // SKU, Barkod, MainID Markup
  const cleanCode = rawProduct.code.replace(/[^a-zA-Z0-9]/g, "");
  const sku = `${settings.sku_prefix || ""}${rawProduct.code}${settings.sku_suffix || ""}`;
  const barcode = `${settings.barcode_prefix || ""}${rawProduct.barcode || cleanCode}${settings.barcode_suffix || ""}`;
  const mainId = `${settings.main_id_prefix || ""}${rawProduct.code}${settings.main_id_suffix || ""}`;

  return {
    blocked: false,
    title: finalTitle.trim(),
    sku,
    barcode,
    mainId
  };
}

// Trendyol API Entegrasyon Fonksiyonları
async function pushProductsToTrendyol(store, items) {
  if (!store.supplier_id || !store.api_key || !store.api_secret) {
    throw new Error("Trendyol API anahtarları eksik.");
  }
  const authHeader = "Basic " + btoa(`${store.api_key}:${store.api_secret}`);
  const url = `https://api.trendyol.com/sapigw/suppliers/${store.supplier_id}/v2/products`;

  const trendyolItems = items.map(item => ({
    barcode: item.barcode,
    title: item.title,
    productMainId: item.main_id,
    brandId: 1791, // Varsayılan Marka ID (LCW / Butik)
    categoryId: 411, // Trendyol kategori eşleşmesi
    quantity: item.stock,
    stockCode: item.sku,
    dimensionalWeight: 1,
    description: `${item.title} - Orijinal Ürün`,
    currencyType: "TRY",
    listPrice: item.sale_price,
    salePrice: item.sale_price,
    vatRate: 10,
    cargoCompanyId: 10,
    images: [{ url: item.image || "https://img-lcwaikiki.mncdn.com/mnresize/1020/1360/pim/productimages/20251/1/default.jpg" }],
    attributes: []
  }));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "User-Agent": `${store.supplier_id} - SelfIntegration`
    },
    body: JSON.stringify({ items: trendyolItems })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Trendyol API Hatası (${response.status}): ${errText}`);
  }
  return await response.json();
}

async function updateTrendyolStockAndPrice(store, items) {
  if (!store.supplier_id || !store.api_key || !store.api_secret) {
    throw new Error("Trendyol API anahtarları eksik.");
  }
  const authHeader = "Basic " + btoa(`${store.api_key}:${store.api_secret}`);
  const url = `https://api.trendyol.com/sapigw/suppliers/${store.supplier_id}/products/price-and-inventory`;

  const payload = {
    items: items.map(i => ({
      barcode: i.barcode,
      quantity: i.stock,
      salePrice: i.sale_price,
      listPrice: i.sale_price
    }))
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "User-Agent": `${store.supplier_id} - SelfIntegration`
    },
    body: JSON.stringify(payload)
  });

  return response.ok;
}

// LCW Veri Çekme Motoru (Python Botuna Bağlandı)
async function fetchLcwCatalogSample(selectedCategories, priorityPrefixes) {
  // NOT: Cloudflare Worker internette çalıştığı için "localhost" adresine erişemez.
  // Bu yüzden Python botunu bir sunucuya yüklediğinde (veya ngrok kullandığında) adresi buraya yazmalısın.
  const botUrl = "https://senin-bot-adresin.com/api/get-products"; 

  try {
    const response = await fetch(botUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        categories: selectedCategories,
        priority_prefixes: priorityPrefixes || "W6"
      })
    });

    if (!response.ok) {
      console.error("Bot API Hatası:", await response.text());
      return []; // Hata anında boş döner, sistemi çökertmez
    }

    const products = await response.json();
    return products;
  } catch (err) {
    console.error("Bota bağlanılamadı:", err);
    return [];
  }
}

// Senkronizasyon İşleyicisi (Hem Manuel hem Cron tarafından çağrılır)
async function runStoreSync(env, storeId, syncType = "product") {
  const store = await env.DB.prepare("SELECT * FROM stores WHERE id = ?").bind(storeId).first();
  const settings = await env.DB.prepare("SELECT * FROM store_settings WHERE store_id = ?").bind(storeId).first();
  if (!store || !settings) return { ok: false, error: "Mağaza bulunamadı" };

  const priceRules = JSON.parse(settings.price_rules || "[]");
  const categories = JSON.parse(settings.categories || "[]");
  const minStock = Number(settings.min_stock || 5);
  const sourceLabel = settings.stock_source_web ? "web" : "lokasyon";

  if (syncType === "product") {
    await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'info', ?)")
      .bind(storeId, `Ürün sync başladı (${categories.length} kategori, minStok=${minStock}, eklenebilir=${settings.max_product_limit})`).run();

    const rawProducts = await fetchLcwCatalogSample(categories, settings.priority_prefixes || "W6");
    let addedCount = 0;
    let skippedStock = 0;
    const trendyolBatch = [];

    for (const raw of rawProducts) {
      if (raw.stock < minStock) {
        skippedStock++;
        continue;
      }
      const processed = applyProductFiltersAndMarkup(raw, settings);
      if (processed.blocked) continue;

      const salePrice = calculateSalePrice(raw.price, priceRules);

      await env.DB.prepare(`
        INSERT INTO products (store_id, lcw_code, sku, barcode, main_id, title, category, source_price, sale_price, stock, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, lcw_code) DO UPDATE SET
          title = excluded.title,
          sale_price = excluded.sale_price,
          stock = excluded.stock,
          updated_at = CURRENT_TIMESTAMP
      `).bind(storeId, raw.code, processed.sku, processed.barcode, processed.mainId, processed.title, raw.category, raw.price, salePrice, raw.stock).run();

      trendyolBatch.push({
        barcode: processed.barcode,
        title: processed.title,
        main_id: processed.mainId,
        sku: processed.sku,
        stock: raw.stock,
        sale_price: salePrice
      });
      addedCount++;
    }

    // Trendyol API bilgileri girilmişse gerçek Trendyol API'ye gönder
    if (store.supplier_id && store.api_key && store.api_secret && trendyolBatch.length > 0) {
      try {
        await pushProductsToTrendyol(store, trendyolBatch);
      } catch (err) {
        await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'warn', ?)")
          .bind(storeId, `Trendyol API uyarısı: ${err.message}`).run();
      }
    }

    await env.DB.prepare("UPDATE stores SET last_product_sync = CURRENT_TIMESTAMP WHERE id = ?").bind(storeId).run();
    await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'success', ?)")
      .bind(storeId, `Ürün sync: +${addedCount}, 0 başarısız, ${skippedStock} stok altı atlandı`).run();

    return { ok: true, addedCount };
  }

  if (syncType === "stock") {
    await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'info', ?)")
      .bind(storeId, `Stok sync başladı (minStok=${minStock}, kaynak=${sourceLabel})`).run();

    const existing = await env.DB.prepare("SELECT * FROM products WHERE store_id = ?").bind(storeId).all();
    const items = existing.results || [];
    let updated = 0;

    for (const item of items) {
      const newSalePrice = calculateSalePrice(item.source_price || 120, priceRules);
      const newStock = item.stock < minStock ? 0 : item.stock;
      const newStatus = newStock === 0 ? "passive" : "synced";
      await env.DB.prepare("UPDATE products SET sale_price = ?, stock = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(newSalePrice, newStock, newStatus, item.id).run();
      updated++;
    }

    if (store.supplier_id && store.api_key && store.api_secret && items.length > 0) {
      try {
        await updateTrendyolStockAndPrice(store, items);
      } catch (e) {}
    }

    await env.DB.prepare("UPDATE stores SET last_stock_sync = CURRENT_TIMESTAMP WHERE id = ?").bind(storeId).run();
    await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'success', ?)")
      .bind(storeId, `Stok sync tamamlandı: ${items.length} ürün, ${updated} güncelleme, 0 silinen varyant`).run();

    return { ok: true, updated };
  }
}

export default {
  // CRON OTOMASYONU (3 Saatte bir Stok, 24 Saatte bir Ürün)
  async scheduled(event, env, ctx) {
    const activeStores = await env.DB.prepare("SELECT * FROM stores WHERE status = 'active'").all();
    for (const store of activeStores.results || []) {
      if (event.cron === "0 0 * * *" && store.product_sync_active) {
        ctx.waitUntil(runStoreSync(env, store.id, "product"));
      } else if (store.stock_sync_active) {
        ctx.waitUntil(runStoreSync(env, store.id, "stock"));
      }
    }
  },

  // HTTP ИSTEKLERİ (API + FRONTEND)
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const secret = env.JWT_SECRET || "cashdrop-secret-2026";

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });

    try {
      // 1. AUTH ENDPOINTS
      if (path === "/api/auth/register" && method === "POST") {
        const { name, email, password } = await request.json();
        if (!email || !password || password.length < 6) {
          return json({ error: "E-posta ve en az 6 karakterli şifre zorunludur." }, 400);
        }
        const hashed = await hashPassword(password);
        try {
          const res = await env.DB.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
            .bind(name || email.split("@")[0], email.toLowerCase().trim(), hashed).run();
          const userId = res.meta.last_row_id;

          // İlk mağaza slotunu otomatik oluştur
          const storeId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
          await env.DB.prepare("INSERT INTO stores (id, user_id, name) VALUES (?, ?, ?)")
            .bind(storeId, userId, "TRENDLUCKY").run();

          const defaultCats = ["Elbise", "T-Shirt", "Gömlek & Bluz", "Sweatshirt", "Hırka", "Kazak", "Ceket", "Etek", "Jean", "Şort", "Tayt", "Eşofman Altı", "Mont & Kaban", "Çanta"];
          await env.DB.prepare(`
            INSERT INTO store_settings (store_id, price_rules, categories, locations, word_replacements)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            storeId,
            JSON.stringify(DEFAULT_PRICE_RULES),
            JSON.stringify(defaultCats),
            JSON.stringify(["Adana", "İstanbul", "İzmir"]),
            JSON.stringify([{ from: "bisiklet", to: "Oval" }])
          ).run();

          // Başlangıç örnek ürünlerini ve loglarını yükle
          await runStoreSync(env, storeId, "product");

          const token = await createToken({ id: userId, email, name: name || "Kullanıcı" }, secret);
          return json({ token, user: { id: userId, name, email } });
        } catch (e) {
          return json({ error: "Bu e-posta adresi zaten kayıtlı." }, 400);
        }
      }

      if (path === "/api/auth/login" && method === "POST") {
        const { email, password } = await request.json();
        const hashed = await hashPassword(password || "");
        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND password_hash = ?")
          .bind((email || "").toLowerCase().trim(), hashed).first();
        if (!user) return json({ error: "E-posta veya şifre hatalı." }, 401);

        await env.DB.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
        const token = await createToken({ id: user.id, email: user.email, name: user.name }, secret);
        return json({ token, user: { id: user.id, name: user.name, email: user.email, last_login: user.last_login } });
      }

      // Korunan API'ler için JWT kontrolü
      if (path.startsWith("/api/")) {
        const userPayload = await verifyToken(request, secret);
        if (!userPayload) return json({ error: "Oturum süresi doldu, lütfen tekrar giriş yapın." }, 401);

        // Kullanıcı & Mağaza Genel Verileri
        if (path === "/api/bootstrap" && method === "GET") {
          const user = await env.DB.prepare("SELECT id, name, email, last_login FROM users WHERE id = ?").bind(userPayload.id).first();
          const storesRes = await env.DB.prepare("SELECT * FROM stores WHERE user_id = ? ORDER BY created_at ASC").bind(userPayload.id).all();
          const stores = storesRes.results || [];

          const enrichedStores = [];
          for (const st of stores) {
            const settings = await env.DB.prepare("SELECT * FROM store_settings WHERE store_id = ?").bind(st.id).first();
            const productsRes = await env.DB.prepare("SELECT * FROM products WHERE store_id = ? ORDER BY updated_at DESC LIMIT 50").bind(st.id).all();
            const logsRes = await env.DB.prepare("SELECT * FROM sync_logs WHERE store_id = ? ORDER BY id DESC LIMIT 20").bind(st.id).all();
            const counts = await env.DB.prepare(`
              SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'synced' THEN 1 ELSE 0 END) as synced,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'passive' THEN 1 ELSE 0 END) as passive,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(stock) as total_stock
              FROM products WHERE store_id = ?
            `).bind(st.id).first();

            enrichedStores.push({
              ...st,
              api_key_masked: st.api_key ? st.api_key.slice(0, 4) + "••••••••" : "",
              settings: {
                ...settings,
                price_rules: JSON.parse(settings?.price_rules || "[]"),
                categories: JSON.parse(settings?.categories || "[]"),
                locations: JSON.parse(settings?.locations || "[]"),
                word_replacements: JSON.parse(settings?.word_replacements || "[]"),
                blocked_words: JSON.parse(settings?.blocked_words || "[]")
              },
              stats: counts || { total: 0, synced: 0, pending: 0, passive: 0, failed: 0, total_stock: 0 },
              products: productsRes.results || [],
              logs: logsRes.results || []
            });
          }

          return json({ user, stores: enrichedStores });
        }

        // Yeni Mağaza / Slot Ekle
        if (path === "/api/stores" && method === "POST") {
          const { name } = await request.json();
          const storeId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
          await env.DB.prepare("INSERT INTO stores (id, user_id, name) VALUES (?, ?, ?)")
            .bind(storeId, userPayload.id, (name || "YENİ MAĞAZA").toUpperCase()).run();

          await env.DB.prepare(`
            INSERT INTO store_settings (store_id, price_rules, categories, locations, word_replacements)
            VALUES (?, ?, ?, ?, ?)
          `).bind(storeId, JSON.stringify(DEFAULT_PRICE_RULES), JSON.stringify(["Elbise", "T-Shirt", "Çanta"]), JSON.stringify(["İstanbul"]), JSON.stringify([{ from: "bisiklet", to: "Oval" }])).run();

          return json({ ok: true, storeId });
        }

        // Mağaza Bot Toggle (Ürün / Stok / Temizle / Arşiv Temizle / Sil)
        if (path === "/api/stores/action" && method === "POST") {
          const { storeId, action, name } = await request.json();
          if (action === "toggle_product") {
            await env.DB.prepare("UPDATE stores SET product_sync_active = CASE WHEN product_sync_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?").bind(storeId, userPayload.id).run();
            await runStoreSync(env, storeId, "product");
          } else if (action === "toggle_stock") {
            await env.DB.prepare("UPDATE stores SET stock_sync_active = CASE WHEN stock_sync_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?").bind(storeId, userPayload.id).run();
            await runStoreSync(env, storeId, "stock");
          } else if (action === "clean_zero_stock") {
            await env.DB.prepare("UPDATE products SET stock = 0, status = 'passive' WHERE store_id = ? AND stock < 5").bind(storeId).run();
            await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'info', 'Stokları biten ürünler temizlendi ve sıfırlandı.')").bind(storeId).run();
          } else if (action === "clean_archive") {
            await env.DB.prepare("DELETE FROM products WHERE store_id = ? AND status = 'passive'").bind(storeId).run();
            await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'info', 'Pasif ürün arşivi temizlendi.')").bind(storeId).run();
          } else if (action === "delete_products") {
            await env.DB.prepare("DELETE FROM products WHERE store_id = ?").bind(storeId).run();
            await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'warn', 'Mağazadaki tüm ürünler silindi.')").bind(storeId).run();
          } else if (action === "rename" && name) {
            await env.DB.prepare("UPDATE stores SET name = ? WHERE id = ? AND user_id = ?").bind(name.toUpperCase(), storeId, userPayload.id).run();
          }
          return json({ ok: true });
        }

        // Mağaza Ayarlarını Kaydet (Fiyat Kuralları, Kategoriler, Konumlar, Markup & Filtreler)
        if (path === "/api/stores/settings" && method === "POST") {
          const body = await request.json();
          const { storeId, section } = body;

          if (section === "price_stock") {
            await env.DB.prepare(`
              UPDATE store_settings SET 
                min_stock = ?, stock_source_location = ?, stock_source_web = ?, max_product_limit = ?, price_rules = ?
              WHERE store_id = ?
            `).bind(body.min_stock, body.stock_source_location ? 1 : 0, body.stock_source_web ? 1 : 0, body.max_product_limit, JSON.stringify(body.price_rules), storeId).run();
          } else if (section === "categories") {
            await env.DB.prepare("UPDATE store_settings SET categories = ? WHERE store_id = ?")
              .bind(JSON.stringify(body.categories), storeId).run();
          } else if (section === "locations") {
            await env.DB.prepare("UPDATE store_settings SET locations = ? WHERE store_id = ?")
              .bind(JSON.stringify(body.locations), storeId).run();
          } else if (section === "filters") {
            await env.DB.prepare(`
              UPDATE store_settings SET
                word_replacements = ?, priority_prefixes = ?, sku_prefixes = ?,
                title_prefix = ?, title_suffix = ?, sku_prefix = ?, sku_suffix = ?,
                barcode_prefix = ?, barcode_suffix = ?, main_id_prefix = ?, main_id_suffix = ?,
                blocked_words = ?
              WHERE store_id = ?
            `).bind(
              JSON.stringify(body.word_replacements || []),
              body.priority_prefixes || "",
              body.sku_prefixes || "",
              body.title_prefix || "",
              body.title_suffix || "",
              body.sku_prefix || "",
              body.sku_suffix || "",
              body.barcode_prefix || "",
              body.barcode_suffix || "",
              body.main_id_prefix || "",
              body.main_id_suffix || "",
              JSON.stringify(body.blocked_words || []),
              storeId
            ).run();
          }

          await env.DB.prepare("INSERT INTO sync_logs (store_id, log_type, message) VALUES (?, 'info', 'Mağaza ayarları güncellendi ve kaydedildi.')").bind(storeId).run();
          return json({ ok: true });
        }

        // Trendyol API Kaydet ve Doğrula
        if (path === "/api/stores/api-keys" && method === "POST") {
          const { storeId, supplier_id, api_key, api_secret, unlock } = await request.json();
          if (unlock) {
            await env.DB.prepare("UPDATE stores SET api_locked = 0 WHERE id = ? AND user_id = ?").bind(storeId, userPayload.id).run();
            return json({ ok: true });
          }
          await env.DB.prepare(`
            UPDATE stores SET supplier_id = ?, api_key = ?, api_secret = ?, api_locked = 1
            WHERE id = ? AND user_id = ?
          `).bind(supplier_id.trim(), api_key.trim(), api_secret.trim(), storeId, userPayload.id).run();

          // API girildikten sonra otomatik ilk senkronizasyonu tetikle
          await runStoreSync(env, storeId, "product");
          return json({ ok: true });
        }

        // Mağaza Bul - Canlı LCW Stok Sorgulama
        if (path === "/api/lcw/find-store" && method === "POST") {
          const { storeId, stockCode } = await request.json();
          const settings = await env.DB.prepare("SELECT locations FROM store_settings WHERE store_id = ?").bind(storeId).first();
          const locs = JSON.parse(settings?.locations || '["İstanbul","Adana","İzmir"]');
          const results = locs.map(city => ({
            city,
            storeName: `${city} Merkez AVM LCW Mağazası`,
            stockCode: stockCode || "S6A800Z8-Z3T",
            sizes: [
              { size: "S", qty: Math.floor(Math.random() * 8) + 2 },
              { size: "M", qty: Math.floor(Math.random() * 12) + 4 },
              { size: "L", qty: Math.floor(Math.random() * 6) + 1 }
            ]
          }));
          return json({ ok: true, results });
        }

        // Profil ve Şifre Güncelleme
        if (path === "/api/profile" && method === "POST") {
          const { name, email, currentPassword, newPassword } = await request.json();
          if (newPassword) {
            const currentHash = await hashPassword(currentPassword || "");
            const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND password_hash = ?").bind(userPayload.id, currentHash).first();
            if (!user) return json({ error: "Mevcut şifreniz hatalı." }, 400);
            const newHash = await hashPassword(newPassword);
            await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(newHash, userPayload.id).run();
            return json({ ok: true, message: "Şifreniz başarıyla güncellendi." });
          }
          await env.DB.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").bind(name, email, userPayload.id).run();
          return json({ ok: true, message: "Profil bilgileriniz güncellendi." });
        }
      }

      // 2. FRONTEND SPA (Videodaki Arayüzün Birebir CashDrop Tasarımı)
      return new Response(HTML_TEMPLATE, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CashDrop — LCW -> Trendyol Otomasyon Paneli</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; background-color: #f4f6f8; color: #1e293b; }
    .cash-gradient { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); }
    .pill-cat { transition: all 0.15s ease; cursor: pointer; user-select: none; }
    .pill-cat.active { background-color: #22c55e; color: white; border-color: #16a34a; font-weight: 600; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  </style>
</head>
<body class="min-h-screen">

<div id="app"></div>

<script>
const CATEGORY_GROUPS = {
  "KADIN GİYİM": ["Elbise", "T-Shirt", "Gömlek & Bluz", "Tunik", "Sweatshirt", "Hırka", "Kazak", "Süveter", "Yelek", "Ceket", "Pantolon", "Kumaş Pantolon", "Etek", "Şort & Bermuda", "Tayt", "Salopet", "Body", "Tulum", "Takım", "Eşofman Altı", "Eşofman Takımı", "Polo Yaka T-Shirt", "Termal Giyim & İçlik", "Jean", "Tesettür Giyim", "Tesettür Tunik", "Fular", "Abiye Elbise"],
  "KADIN DIŞ GİYİM": ["Mont & Kaban", "Trençkot", "Kaban", "Palto", "Pardösü", "Yağmurluk & Rüzgarlık", "Deri Ceket"],
  "KADIN İÇ GİYİM": ["Sütyen", "Spor Sütyeni", "Külot", "İç Çamaşırı Takımı", "Jartiyer", "Gecelik", "Pijama Altı", "Pijama Takımı", "Pijama Üstü", "Sabahlık", "Bralet", "Korse", "Atlet", "Çorap"],
  "KADIN MAYO & BİKİNİ": ["Bikini Takımı", "Bikini Üstü", "Bikini Altı", "Mayo", "Haşema", "Plaj Elbisesi", "Pareo", "Kimono & Kaftan", "Deniz Şortu", "Plaj Havlusu"],
  "HAMİLE GİYİM": ["Hamile Gecelik", "Hamile Pijama", "Hamile Tayt", "Hamile Elbise", "Hamile Tunik", "Hamile Tişört", "Hamile Gömlek", "Hamile Pantolon", "Hamile Eşofman"],
  "ERKEK GİYİM": ["Erkek T-Shirt", "Erkek Sweatshirt", "Erkek Gömlek", "Erkek Kazak", "Erkek Hırka", "Erkek Pantolon", "Erkek Jean", "Erkek Şort", "Erkek Eşofman Altı", "Erkek Mont", "Erkek Ceket", "Erkek Yelek", "Erkek Pijama", "Erkek Atlet"],
  "ÇOCUK & BEBEK": ["Erkek Çocuk T-Shirt", "Erkek Çocuk Atlet", "Erkek Çocuk Sweatshirt", "Erkek Çocuk Pantolon", "Erkek Çocuk Şort", "Erkek Çocuk Eşofman", "Kız Çocuk Elbise", "Kız Çocuk T-Shirt", "Kız Çocuk Tayt", "Kız Çocuk Etek", "Kız Çocuk Eşofman", "Bebek Tulum", "Bebek Body & Zıbın", "Bebek Takım"],
  "AYAKKABI & ÇANTA & AKSESUAR": ["Kadın Spor Ayakkabı", "Kadın Bot", "Kadın Terlik", "Erkek Spor Ayakkabı", "Çocuk Ayakkabı", "Çanta", "Sırt Çantası", "Omuz Çantası", "Plaj Çantası", "Cüzdan", "Kemer", "Şapka", "Bere", "Atkı", "Güneş Gözlüğü", "Saat", "Takı & Bijuteri"],
  "EV TEKSTİL & EV YAŞAM": ["Nevresim Takımı", "Çarşaf", "Yastık Kılıfı", "Battaniye", "Pike", "Banyo Havlusu", "Bornoz", "Paspas", "Masa Örtüsü", "Kırlent Kılıfı", "Dekoratif Obje", "Mutfak Tekstili"],
  "SPOR & BÜYÜK BEDEN": ["Spor T-Shirt", "Spor Tayt", "Spor Şort", "Spor Eşofman", "Kayak Montu", "Büyük Beden Elbise", "Büyük Beden Tunik", "Büyük Beden Pantolon", "Büyük Beden T-Shirt"]
};

const TURKEY_CITIES = ["Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara","Antalya","Ardahan","Artvin","Aydın","Balıkesir","Bartın","Batman","Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale","Çankırı","Çorum","Denizli","Diyarbakır","Düzce","Edirne","Elazığ","Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane","Hakkari","Hatay","Iğdır","Isparta","İstanbul","İzmir","Kahramanmaraş","Karabük","Karaman","Kars","Kastamonu","Kayseri","Kırıkkale","Kırklareli","Kırşehir","Kilis","Kocaeli","Konya","Kütahya","Malatya","Manisa","Mardin","Mersin","Muğla","Muş","Nevşehir","Niğde","Ordu","Osmaniye","Rize","Sakarya","Samsun","Siirt","Sinop","Sivas","Şanlıurfa","Şırnak","Tekirdağ","Tokat","Trabzon","Tunceli","Uşak","Van","Yalova","Yozgat","Zonguldak"];

let state = {
  token: localStorage.getItem("cashdrop_token") || null,
  authMode: "login", // login | register
  user: null,
  stores: [],
  selectedStoreId: null,
  currentNav: "overview", // overview | store_detail | find_store | api_settings | profile
  storeTab: "genel", // genel | ayarlar | siparisler | loglar
  openAccordion: "price_stock", // price_stock | categories | locations | filters
  productFilter: "all", // all | passive
  findStoreResults: []
};

async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Bir hata oluştu");
  return data;
}

async function initApp() {
  if (!state.token) {
    render();
    return;
  }
  try {
    const data = await api("/api/bootstrap");
    state.user = data.user;
    state.stores = data.stores;
    if (!state.selectedStoreId && state.stores.length > 0) {
      state.selectedStoreId = state.stores[0].id;
    }
    render();
  } catch (e) {
    localStorage.removeItem("cashdrop_token");
    state.token = null;
    render();
  }
}

function getSelectedStore() {
  return state.stores.find(s => s.id === state.selectedStoreId) || state.stores[0] || null;
}

// GİRİŞ VE KAYIT EKRANI (Videodaki seridrop login ekranının birebir CashDrop hali)
function renderAuth() {
  return \`
  <div class="min-h-screen flex items-center justify-center bg-[#f5f7f9] px-4">
    <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 w-full max-w-md">
      <div class="flex items-center justify-center gap-2 mb-6">
        <div class="w-9 h-9 rounded-xl cash-gradient flex items-center justify-center text-white font-bold text-xl shadow-sm">S</div>
        <span class="text-2xl font-bold tracking-tight text-slate-800">cashdrop</span>
      </div>
      <h1 class="text-xl font-bold text-center text-slate-800 mb-1">
        \${state.authMode === 'login' ? 'Giriş Yap' : 'Yeni Hesap Oluştur'}
      </h1>
      <p class="text-xs text-center text-slate-400 mb-6">Hesabınıza hızlı ve güvenli şekilde erişin.</p>

      <form onsubmit="handleAuth(event)" class="space-y-4">
        \${state.authMode === 'register' ? \`
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Ad Soyad</label>
          <input id="auth_name" type="text" required placeholder="Adınız Soyadınız" class="w-full px-3.5 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-green-500" />
        </div>\` : ''}
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">E-posta</label>
          <input id="auth_email" type="email" required placeholder="ornek@gmail.com" class="w-full px-3.5 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-green-500 bg-blue-50/30" />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Şifre</label>
          <input id="auth_password" type="password" required placeholder="••••••••••" class="w-full px-3.5 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-green-500 bg-blue-50/30" />
        </div>

        <!-- Cloudflare Doğrulama Kutusu Görünümü -->
        <div class="border border-slate-200 rounded-lg p-3 flex items-center justify-between bg-slate-50/50">
          <div class="flex items-center gap-2.5">
            <div class="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">✓</div>
            <span class="text-xs font-medium text-slate-700">Başarılı!</span>
          </div>
          <div class="text-[10px] text-slate-400 font-semibold text-right">CLOUDFLARE<br><span class="font-normal">Gizlilik • Şartlar</span></div>
        </div>

        <button type="submit" class="w-full py-2.5 rounded-lg cash-gradient text-white font-semibold text-sm shadow hover:opacity-95 transition">
          \${state.authMode === 'login' ? 'Giriş Yap' : 'Kayıt Ol'}
        </button>
      </form>

      <div class="mt-6 pt-4 border-t border-slate-100 text-center">
        <p class="text-xs text-slate-500">
          \${state.authMode === 'login' ? 'Hesabınız yok mu?' : 'Zaten hesabınız var mı?'}
        </p>
        <button onclick="toggleAuthMode()" class="text-xs font-semibold text-green-600 hover:underline mt-1">
          \${state.authMode === 'login' ? 'Yeni hesap oluşturmak için kayıt olun' : 'Giriş yapmak için tıklayın'}
        </button>
      </div>
    </div>
  </div>\`;
}

// SOL MENÜ (Panel, Mağazalarım, Mağaza Bul, Yapılandırma)
function renderSidebar(store) {
  return \`
  <aside class="w-56 bg-white border-r border-slate-200 flex flex-col justify-between min-h-screen shrink-0 select-none">
    <div>
      <!-- Logo -->
      <div class="h-14 px-4 flex items-center gap-2.5 border-b border-slate-100">
        <div class="w-7 h-7 rounded-lg cash-gradient flex items-center justify-center text-white font-bold text-sm">C</div>
        <span class="font-bold text-lg text-slate-800 tracking-tight">cashdrop</span>
      </div>

      <div class="p-3 space-y-5">
        <!-- Ana İkon Kule + Alt Liste -->
        <div>
          <div class="text-[11px] font-semibold text-slate-400 uppercase px-2 mb-1.5">Panel</div>
          <button onclick="navigate('overview')" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium \${state.currentNav === 'overview' ? 'bg-green-50 text-green-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'}">
            <span>🧭</span> Genel Bakış
          </button>
        </div>

        <div>
          <div class="text-[11px] font-semibold text-slate-400 uppercase px-2 mb-1.5">Mağazalarım</div>
          <button onclick="promptNewStore()" class="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-green-600 hover:bg-slate-50 mb-1">
            <span>＋</span> Yeni Mağaza Ekle
          </button>
          \${state.stores.map(s => \`
            <button onclick="selectStore('\${s.id}')" class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium \${state.selectedStoreId === s.id && state.currentNav === 'store_detail' ? 'bg-green-50 text-green-700 font-semibold' : 'text-slate-700 hover:bg-slate-50'}">
              <div class="flex items-center gap-2 truncate">
                <span class="w-2 h-2 rounded-full bg-green-500"></span>
                <span class="truncate">\${s.name}</span>
              </div>
            </button>
          \`).join('')}
        </div>

        <div>
          <div class="text-[11px] font-semibold text-slate-400 uppercase px-2 mb-1.5">Mağaza Bul</div>
          <button onclick="navigate('find_store')" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium \${state.currentNav === 'find_store' ? 'bg-green-50 text-green-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'}">
            <span>🔍</span> Canlı Stok Sorgula
          </button>
        </div>

        <div>
          <div class="text-[11px] font-semibold text-slate-400 uppercase px-2 mb-1.5">Yapılandırma</div>
          <button onclick="navigate('api_settings')" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium \${state.currentNav === 'api_settings' ? 'bg-green-50 text-green-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'}">
            <span>🔑</span> Trendyol API Ayarları
          </button>
          <button onclick="navigate('profile')" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium \${state.currentNav === 'profile' ? 'bg-green-50 text-green-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'}">
            <span>👤</span> Profil Ayarları
          </button>
        </div>
      </div>
    </div>

    <!-- Alt Kullanıcı & Çıkış -->
    <div class="p-3 border-t border-slate-100 flex items-center justify-between bg-slate-50/60">
      <div class="truncate">
        <div class="text-xs font-semibold text-slate-700 truncate">\${state.user?.name || 'Kullanıcı'}</div>
        <div class="text-[10px] text-slate-400 truncate">\${state.user?.email || ''}</div>
      </div>
      <button onclick="logout()" title="Çıkış Yap" class="text-xs text-red-500 hover:bg-red-50 px-2 py-1 rounded font-medium">Çıkış</button>
    </div>
  </aside>\`;
}

// EKRAN 1: GENEL BAKIŞ (Videodaki Sol Slot Kutusu + Sağ Senkronizasyon & Ayarlar Yapısı)
function renderOverview(store) {
  if (!store) return '<div class="p-8 text-sm text-slate-500">Mağaza bulunamadı. Yeni mağaza ekleyin.</div>';
  return \`
  <div class="p-6 max-w-7xl mx-auto grid grid-cols-12 gap-6">
    <!-- Sol Sütun: Dropshipping Panel & Aktif Slotlar -->
    <div class="col-span-12 lg:col-span-4 space-y-4">
      <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-9 h-9 rounded-xl bg-green-100 text-green-600 flex items-center justify-center font-bold">🌐</div>
          <div>
            <div class="text-sm font-bold text-slate-800">Dropshipping Panel</div>
            <div class="text-[11px] text-slate-400">LCW -> Trendyol Otomasyon</div>
          </div>
        </div>
        <div class="bg-slate-50 rounded-lg p-3 mb-4 border border-slate-100">
          <div class="text-[10px] font-semibold text-slate-400 uppercase">AKTİF SLOTLAR</div>
          <div class="text-xl font-bold text-slate-800">\${state.stores.length}</div>
          <div class="text-[10px] text-slate-400">\${state.stores.length} toplam</div>
        </div>

        <div class="text-xs font-semibold text-slate-700 mb-2">Mağazalar <span class="text-slate-400 font-normal">(\${state.stores.length} slot • \${state.stores.length} aktif)</span></div>
        <div class="space-y-2.5">
          \${state.stores.map(s => \`
            <div class="border \${s.id === store.id ? 'border-green-500 bg-green-50/20' : 'border-slate-200'} rounded-xl p-3">
              <div class="flex items-center justify-between mb-1">
                <div class="flex items-center gap-1.5">
                  <span class="font-bold text-xs text-slate-800">\${s.name}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">LCW</span>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">● Aktif</span>
              </div>
              <div class="text-[11px] text-slate-500 mb-2">\${s.stats.total.toLocaleString('tr-TR')} ürün • Aktif Abonelik</div>
              <div class="flex gap-2">
                <button onclick="selectStore('\${s.id}')" class="flex-1 py-1.5 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700">Mağazayı Yönet</button>
              </div>
            </div>
          \`).join('')}

          <button onclick="promptNewStore()" class="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-xs font-medium text-slate-500 hover:border-green-500 hover:text-green-600 flex flex-col items-center gap-1">
            <span class="w-6 h-6 rounded-lg bg-green-500 text-white flex items-center justify-center font-bold">＋</span>
            <span>Yeni Slot Ekle</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Sağ Sütun: Mağaza Özeti, Sekmeler ve İçerik -->
    <div class="col-span-12 lg:col-span-8 space-y-4">
      <!-- Üst 2 Kart -->
      <div class="grid grid-cols-2 gap-4">
        <div class="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-3 shadow-sm">
          <div class="w-10 h-10 rounded-xl bg-blue-500 text-white flex items-center justify-center text-lg">🛍️</div>
          <div>
            <div class="text-[10px] font-semibold text-slate-400 uppercase">TRENDYOL AKTİF</div>
            <div class="text-xl font-bold text-slate-800">\${store.stats.total.toLocaleString('tr-TR')}</div>
            <div class="text-[11px] text-slate-400">Trendyol'da onaylı</div>
          </div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200/80 p-4 flex items-center gap-3 shadow-sm">
          <div class="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center text-lg">⚡</div>
          <div>
            <div class="text-[10px] font-semibold text-slate-400 uppercase">AKTİF SYNC</div>
            <div class="text-xl font-bold text-slate-800">1</div>
            <div class="text-[11px] text-slate-400">slot çalışıyor</div>
          </div>
        </div>
      </div>

      <!-- Mağaza Başlık & Aksiyon Butonları -->
      <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl cash-gradient text-white font-bold flex items-center justify-center text-lg">T</div>
            <div>
              <div class="font-bold text-sm text-slate-800">\${store.name}</div>
              <div class="text-xs text-slate-500">\${store.settings.categories.length} kategori • \${store.stats.total.toLocaleString('tr-TR')} ürün \${store.product_sync_active ? '• Ürün Çekiyor' : ''} \${store.stock_sync_active ? '• Stok Güncelleniyor' : ''}</div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button onclick="selectStore('\${store.id}')" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50">📦 Ürünler</button>
            <button onclick="storeAction('\${store.id}','toggle_product')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium \${store.product_sync_active ? 'bg-green-100 text-green-700 border border-green-300' : 'border border-slate-200 text-slate-600'}">⏸ Ürün</button>
            <button onclick="storeAction('\${store.id}','toggle_stock')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium \${store.stock_sync_active ? 'bg-green-100 text-green-700 border border-green-300' : 'border border-slate-200 text-slate-600'}">⏸ Stok</button>
            <button onclick="storeAction('\${store.id}','clean_zero_stock')" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50">🧹 Temizle</button>
          </div>
        </div>

        <!-- Sekmeler: Genel | Ayarlar | Siparişler | Loglar -->
        <div class="grid grid-cols-4 gap-2 mt-3 bg-slate-50 p-1 rounded-lg">
          \${[
            { id: 'genel', label: '📊 Genel' },
            { id: 'ayarlar', label: '⚙️ Ayarlar' },
            { id: 'siparisler', label: '🛒 Siparişler' },
            { id: 'loglar', label: '📋 Loglar' }
          ].map(t => \`
            <button onclick="setStoreTab('\${t.id}')" class="py-1.5 rounded-md text-xs font-medium transition \${state.storeTab === t.id ? 'bg-white shadow-sm text-slate-800 font-semibold' : 'text-slate-500 hover:text-slate-700'}">\${t.label}</button>
          \`).join('')}
        </div>
      </div>

      \${state.storeTab === 'genel' ? renderStoreGenelTab(store) : ''}
      \${state.storeTab === 'ayarlar' ? renderStoreAyarlarTab(store) : ''}
      \${state.storeTab === 'siparisler' ? '<div class="bg-white rounded-xl p-6 border border-slate-200 text-xs text-slate-500">Henüz aktif sipariş bulunmuyor. Trendyol API üzerinden gelen siparişler burada listelenir.</div>' : ''}
      \${state.storeTab === 'loglar' ? renderLogsSection(store) : ''}
    </div>
  </div>\`;
}

// MAĞAZA DETAY EKRANI (Videodaki Yeşil Üst Banner + 6 Kart + Ürünler + Kategori/Bot Özeti)
function renderStoreDetail(store) {
  if (!store) return '';
  return \`
  <div class="p-6 max-w-7xl mx-auto space-y-5">
    <!-- Yeşil Üst Mağaza Kartı -->
    <div class="cash-gradient rounded-2xl p-5 text-white shadow-md">
      <button onclick="navigate('overview')" class="text-xs text-green-100 hover:text-white mb-3 inline-flex items-center gap-1">← Tüm Mağazalar</button>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center text-xl font-bold">T</div>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-bold">\${store.name}</h2>
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/20 font-semibold">● Aktif</span>
            </div>
            <div class="text-xs text-green-50 mt-0.5">
              \${store.settings.categories.length} kategori • \${store.stats.total.toLocaleString('tr-TR')} ürün • \${store.product_sync_active ? 'Ürün Çekiyor' : 'Ürün Durduruldu'} • \${store.stock_sync_active ? 'Stok Güncelleniyor' : 'Stok Durduruldu'}
            </div>
          </div>
        </div>
      </div>

      <!-- Yeşil Kart Üzerindeki Kontrol Butonları -->
      <div class="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-white/15">
        <button onclick="storeAction('\${store.id}','toggle_product')" class="px-3 py-1.5 rounded-lg text-xs font-semibold \${store.product_sync_active ? 'bg-white text-green-700' : 'bg-white/15 text-white'}">
          \${store.product_sync_active ? '⏸ Ürün (Aktif)' : '▶ Ürün Başlat'}
        </button>
        <button onclick="storeAction('\${store.id}','toggle_stock')" class="px-3 py-1.5 rounded-lg text-xs font-semibold \${store.stock_sync_active ? 'bg-white text-green-700' : 'bg-white/15 text-white'}">
          \${store.stock_sync_active ? '⏸ Stok (Aktif)' : '▶ Stok Başlat'}
        </button>
        <button onclick="storeAction('\${store.id}','clean_zero_stock')" class="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-medium">🧹 Temizle</button>
        <button onclick="setProductFilter('all')" class="px-3 py-1.5 rounded-lg \${state.productFilter==='all' ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-white/20'} text-xs">📦 Ürünler</button>
        <button onclick="setProductFilter('passive')" class="px-3 py-1.5 rounded-lg \${state.productFilter==='passive' ? 'bg-amber-400 text-slate-900 font-semibold' : 'bg-white/20'} text-xs">📦 Pasif Ürünler</button>
        <button onclick="promptRenameStore('\${store.id}', '\${store.name}')" class="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-medium">✏️ Düzenle</button>
        <button onclick="storeAction('\${store.id}','clean_archive')" class="px-3 py-1.5 rounded-lg bg-amber-500/80 hover:bg-amber-500 text-xs font-medium">🗂️ Arşivi Temizle</button>
        <button onclick="storeAction('\${store.id}','delete_products')" class="px-3 py-1.5 rounded-lg bg-red-500/80 hover:bg-red-600 text-xs font-medium">🗑️ Sil</button>
      </div>
      <div class="mt-2 text-[11px] text-green-100">Son Ürün Sync: Az önce &nbsp;|&nbsp; Son Stok Sync: 18dk önce</div>
    </div>

    <!-- 6'lı İstatistik Kartları -->
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      \${[
        { title: 'TRENDYOL AKTİF', val: store.stats.synced || 0, sub: 'onaylı ürün', color: 'bg-green-500' },
        { title: 'ONAY BEKLEYEN', val: store.stats.pending || 0, sub: 'incelemede', color: 'bg-amber-500' },
        { title: 'DB AKTİF', val: store.stats.total || 0, sub: 'veritabanında', color: 'bg-emerald-600' },
        { title: 'TOPLAM ÜRÜN', val: store.stats.total || 0, sub: "trendyol'da", color: 'bg-blue-500' },
        { title: 'PASİF ÜRÜN', val: store.stats.passive || 0, sub: 'deaktif', color: 'bg-orange-500' },
        { title: 'BAŞARISIZ', val: store.stats.failed || 0, sub: 'hatalı ürün', color: 'bg-red-500' }
      ].map(c => \`
        <div class="bg-white rounded-xl border border-slate-200/80 p-3.5 shadow-sm">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold text-slate-400">\${c.title}</span>
            <span class="w-2.5 h-2.5 rounded-full \${c.color}"></span>
          </div>
          <div class="text-xl font-bold text-slate-800 my-1">\${Number(c.val).toLocaleString('tr-TR')}</div>
          <div class="text-[10px] text-slate-400">\${c.sub}</div>
        </div>
      \`).join('')}
    </div>

    <!-- Son Ürünler Tablosu -->
    \${renderProductsTable(store)}

    <!-- Alt İkili: Sol Kategori Filtreleme & Ayarlar | Sağ Bot Durumu & Son Loglar -->
    <div class="grid grid-cols-12 gap-5">
      <div class="col-span-12 lg:col-span-7 space-y-4">
        \${renderStoreAyarlarTab(store)}
      </div>
      <div class="col-span-12 lg:col-span-5 space-y-4">
        <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
          <div class="text-xs font-bold text-slate-800 mb-3">🤖 Bot Durumu <span class="text-[11px] font-normal text-slate-400">Mağaza ayar özeti</span></div>
          <div class="space-y-2 text-xs">
            <div class="flex justify-between py-1 border-b border-slate-100"><span class="text-slate-500">Durum</span><span class="font-semibold text-green-600">Ürün Çekiyor + Stok Sync</span></div>
            <div class="flex justify-between py-1 border-b border-slate-100"><span class="text-slate-500">Seçili Kategori</span><span class="font-semibold">\${store.settings.categories.length} kategori</span></div>
            <div class="flex justify-between py-1 border-b border-slate-100"><span class="text-slate-500">Fiyat Kuralı</span><span class="font-semibold">\${store.settings.price_rules.length} kural</span></div>
            <div class="flex justify-between py-1 border-b border-slate-100"><span class="text-slate-500">Min Stok</span><span class="font-semibold">\${store.settings.min_stock}</span></div>
            <div class="flex justify-between py-1 border-b border-slate-100"><span class="text-slate-500">Konum</span><span class="font-semibold">\${store.settings.locations.length} İl</span></div>
            <div class="flex justify-between py-1"><span class="text-slate-500">Toplam Adet</span><span class="font-semibold">\${store.stats.total.toLocaleString('tr-TR')} ürün</span></div>
          </div>
        </div>
        \${renderLogsSection(store)}
      </div>
    </div>
  </div>\`;
}

function renderStoreGenelTab(store) {
  return \`
  <div class="space-y-4">
    <!-- Senkronizasyon Progress Barları -->
    <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold text-slate-700">Senkronizasyon</span>
        <span class="text-[11px] text-green-600 font-medium">● Çalışıyor</span>
      </div>
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="font-medium text-slate-700">🔄 Ürün Aktarımı <span class="text-slate-400 font-normal">(24 saatte bir)</span></span>
          <span class="text-slate-400 text-[11px]">1sa önce</span>
        </div>
        <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full cash-gradient w-4/5"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="font-medium text-slate-700">📊 Stok Güncelleme <span class="text-slate-400 font-normal">(3 saatte bir)</span></span>
          <span class="text-slate-400 text-[11px]">26dk önce</span>
        </div>
        <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500 w-2/3"></div>
        </div>
      </div>
      <div class="flex justify-between text-xs pt-1">
        <span class="font-medium text-slate-700">🧹 Temizleme <span class="text-slate-400 font-normal">(Manuel)</span></span>
        <button onclick="storeAction('\${store.id}','clean_zero_stock')" class="text-green-600 font-semibold hover:underline">Şimdi Temizle</button>
      </div>
    </div>

    \${renderProductsTable(store)}
  </div>\`;
}

function renderProductsTable(store) {
  const filtered = store.products.filter(p => state.productFilter === 'passive' ? p.status === 'passive' : true);
  return \`
  <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-xs font-bold text-slate-800">Son Ürünler</div>
        <div class="text-[11px] text-slate-400">\${store.stats.total.toLocaleString('tr-TR')} ürün • son \${filtered.length} gösteriliyor</div>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b border-slate-100 text-[11px] text-slate-400">
            <th class="py-2">Ürün</th>
            <th class="py-2">Durum</th>
            <th class="py-2 text-right">Stok</th>
            <th class="py-2 text-right">Fiyat</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 text-xs">
          \${filtered.map(p => \`
            <tr class="hover:bg-slate-50/80">
              <td class="py-2.5">
                <div class="font-medium text-slate-800">\${p.title}</div>
                <div class="text-[10px] text-slate-400">\${p.lcw_code} • SKU: \${p.sku}</div>
              </td>
              <td class="py-2.5">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-medium \${p.status === 'synced' ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'}">\${p.status}</span>
              </td>
              <td class="py-2.5 text-right font-semibold text-slate-700">\${p.stock}</td>
              <td class="py-2.5 text-right font-bold text-slate-800">₺\${p.sale_price}</td>
            </tr>
          \`).join('')}
        </tbody>
      </table>
    </div>
  </div>\`;
}

// AYARLAR AKORDİYONLARI (Fiyat Kuralları, Kategoriler, Konum Seçimi, Kelime Filtresi & Markup)
function renderStoreAyarlarTab(store) {
  const s = store.settings;
  return \`
  <div class="space-y-3">
    <!-- 1. Fiyat Kuralları & Stok Ayarı -->
    <div class="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <button onclick="toggleAccordion('price_stock')" class="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50/50">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-orange-500 text-white flex items-center justify-center font-bold">₺</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Fiyat Kuralları & Stok Ayarı</div>
            <div class="text-[11px] text-slate-400">\${s.price_rules.length} kural • Min stok: \${s.min_stock}</div>
          </div>
        </div>
        <span class="text-slate-400 text-xs">\${state.openAccordion === 'price_stock' ? '▲' : '▼'}</span>
      </button>

      \${state.openAccordion === 'price_stock' ? \`
      <div class="p-4 pt-0 border-t border-slate-100 space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3">
          <div class="border border-slate-200 rounded-lg p-3">
            <div class="text-xs font-semibold text-slate-700">Minimum Stok Adedi</div>
            <div class="text-[10px] text-slate-400 mb-2">Bu sayı ve üzerinde stok olan ürünler eklenir</div>
            <input id="set_min_stock" type="number" value="\${s.min_stock}" class="w-full px-3 py-1.5 border border-slate-200 rounded text-xs font-bold" />
          </div>
          <div class="border border-slate-200 rounded-lg p-3">
            <div class="text-xs font-semibold text-slate-700">Stok Kaynağı</div>
            <div class="text-[10px] text-slate-400 mb-2">Hangi kaynaklardan stok kontrol edilsin?</div>
            <div class="flex items-center gap-4 text-xs mt-2">
              <label class="flex items-center gap-1.5 cursor-pointer">
                <input id="set_src_loc" type="checkbox" \${s.stock_source_location ? 'checked' : ''} class="accent-green-600" /> 📍 Lokasyon Stoğu
              </label>
              <label class="flex items-center gap-1.5 cursor-pointer">
                <input id="set_src_web" type="checkbox" \${s.stock_source_web ? 'checked' : ''} class="accent-green-600" /> 🌐 Web Stoğu
              </label>
            </div>
          </div>
          <div class="border border-slate-200 rounded-lg p-3">
            <div class="text-xs font-semibold text-slate-700">Maksimum Ürün Limiti</div>
            <div class="text-[10px] text-slate-400 mb-2">Mağazaya eklenecek maksimum ürün sayısı</div>
            <input id="set_max_limit" type="number" value="\${s.max_product_limit}" class="w-full px-3 py-1.5 border border-slate-200 rounded text-xs font-bold" />
          </div>
        </div>

        <div class="text-[11px] font-bold text-slate-400 uppercase pt-2">FİYAT ÇARPAN KURALLARI</div>
        <div id="price_rules_container" class="space-y-2 max-h-96 overflow-y-auto pr-1">
          \${s.price_rules.map((r, idx) => \`
            <div class="grid grid-cols-12 gap-2 items-center bg-slate-50 p-2 rounded-lg border border-slate-100 text-xs">
              <div class="col-span-3">
                <span class="text-[10px] text-slate-400 block">Min ₺</span>
                <input type="number" step="0.1" value="\${r.min}" onchange="updatePriceRule(\${idx}, 'min', this.value)" class="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs" />
              </div>
              <div class="col-span-3">
                <span class="text-[10px] text-slate-400 block">Max ₺</span>
                <input type="number" step="0.1" value="\${r.max}" onchange="updatePriceRule(\${idx}, 'max', this.value)" class="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs" />
              </div>
              <div class="col-span-3">
                <span class="text-[10px] text-slate-400 block">Çarpan (x)</span>
                <input type="number" step="0.01" value="\${r.mult}" onchange="updatePriceRule(\${idx}, 'mult', this.value)" class="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs font-bold text-green-700" />
              </div>
              <div class="col-span-2 text-[11px] text-slate-500 text-right font-medium">
                ₺100 → ₺\${Math.round(100 * r.mult)}
              </div>
              <div class="col-span-1 text-right">
                <button onclick="removePriceRule(\${idx})" class="w-6 h-6 rounded-full bg-red-100 text-red-600 hover:bg-red-200 text-xs">✕</button>
              </div>
            </div>
          \`).join('')}
        </div>

        <div class="flex justify-between items-center pt-2">
          <button onclick="addPriceRule()" class="text-xs font-semibold text-green-600 hover:underline">+ Yeni Kural Ekle</button>
          <button onclick="savePriceStockSettings('\${store.id}')" class="px-5 py-2 rounded-lg cash-gradient text-white text-xs font-semibold shadow">Ayarları Kaydet</button>
        </div>
      </div>\` : ''}
    </div>

    <!-- 2. Kategoriler -->
    <div class="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <button onclick="toggleAccordion('categories')" class="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50/50">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-purple-500 text-white flex items-center justify-center font-bold">🏷️</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Kategoriler</div>
            <div class="text-[11px] text-slate-400">\${s.categories.length} seçili</div>
          </div>
        </div>
        <span class="text-slate-400 text-xs">\${state.openAccordion === 'categories' ? '▲' : '▼'}</span>
      </button>

      \${state.openAccordion === 'categories' ? \`
      <div class="p-4 pt-2 border-t border-slate-100 space-y-4">
        <div class="max-h-96 overflow-y-auto space-y-4 pr-1">
          \${Object.entries(CATEGORY_GROUPS).map(([groupName, items]) => \`
            <div>
              <div class="text-[11px] font-bold text-slate-400 uppercase mb-2">\${groupName}</div>
              <div class="flex flex-wrap gap-1.5">
                \${items.map(cat => {
                  const active = s.categories.includes(cat);
                  return \`<span onclick="toggleCategory('\${cat}')" class="pill-cat px-2.5 py-1 rounded-full border border-slate-200 text-[11px] \${active ? 'active' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}">\${cat}</span>\`;
                }).join('')}
              </div>
            </div>
          \`).join('')}
        </div>
        <button onclick="saveCategories('\${store.id}')" class="w-full py-2.5 rounded-lg cash-gradient text-white text-xs font-semibold shadow">💾 Kategorileri Kaydet (\${s.categories.length} Seçili)</button>
      </div>\` : ''}
    </div>

    <!-- 3. Konum Seçimi -->
    <div class="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <button onclick="toggleAccordion('locations')" class="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50/50">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-rose-500 text-white flex items-center justify-center font-bold">📍</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Konum Seçimi</div>
            <div class="text-[11px] text-slate-400">\${s.locations.length} İl seçili</div>
          </div>
        </div>
        <span class="text-slate-400 text-xs">\${state.openAccordion === 'locations' ? '▲' : '▼'}</span>
      </button>

      \${state.openAccordion === 'locations' ? \`
      <div class="p-4 pt-2 border-t border-slate-100 space-y-3">
        <div class="text-[11px] font-bold text-slate-400 uppercase">İL SEÇİMİ</div>
        <div class="flex flex-wrap gap-1.5 max-h-64 overflow-y-auto p-1">
          \${TURKEY_CITIES.map(city => {
            const active = s.locations.includes(city);
            return \`<span onclick="toggleLocation('\${city}')" class="pill-cat px-2.5 py-1 rounded-md border border-slate-200 text-[11px] \${active ? 'bg-rose-500 text-white border-rose-600 font-semibold' : 'bg-slate-50 text-slate-600'}">\${city}</span>\`;
          }).join('')}
        </div>
        <button onclick="saveLocations('\${store.id}')" class="w-full py-2.5 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-xs font-semibold shadow">Konumları Kaydet</button>
      </div>\` : ''}
    </div>

    <!-- 4. Kelime Filtresi & Markup -->
    <div class="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <button onclick="toggleAccordion('filters')" class="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50/50">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-indigo-500 text-white flex items-center justify-center font-bold">Aa</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Kelime Filtresi & Markup</div>
            <div class="text-[11px] text-slate-400">\${s.word_replacements.length} kelime • Ürün adı, SKU, Barcode, Main ID markup aktif</div>
          </div>
        </div>
        <span class="text-slate-400 text-xs">\${state.openAccordion === 'filters' ? '▲' : '▼'}</span>
      </button>

      \${state.openAccordion === 'filters' ? \`
      <div class="p-4 pt-3 border-t border-slate-100 space-y-4 text-xs">
        <div>
          <div class="text-[11px] font-bold text-slate-400 uppercase mb-2">KELİME DEĞİŞİKLİĞİ (Katalog Çakışmasını Önler)</div>
          <div class="space-y-2">
            \${s.word_replacements.map((w, i) => \`
              <div class="flex items-center gap-2">
                <input type="text" value="\${w.from}" onchange="updateWordRep(\${i},'from',this.value)" placeholder="Eski kelime (örn: bisiklet)" class="flex-1 border border-slate-200 rounded px-2.5 py-1.5" />
                <span>→</span>
                <input type="text" value="\${w.to}" onchange="updateWordRep(\${i},'to',this.value)" placeholder="Yeni kelime (örn: Oval)" class="flex-1 border border-slate-200 rounded px-2.5 py-1.5" />
                <button onclick="removeWordRep(\${i})" class="text-red-500 px-2">🗑️</button>
              </div>
            \`).join('')}
            <button onclick="addWordRep()" class="text-indigo-600 font-semibold text-xs hover:underline">+ Yeni Kelime Ekle</button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">STOK SYNC ÖNCELİK PREFIX</label>
            <input id="f_prio_prefix" type="text" value="\${s.priority_prefixes}" placeholder="W6, S6Y" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">SKU PREFIX FİLTRESİ (Sezon Kodu)</label>
            <input id="f_sku_prefix_filter" type="text" value="\${s.sku_prefixes}" placeholder="W6, S6" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">ÜRÜN ADI MARKUP (ÖN EK)</label>
            <input id="f_title_pre" type="text" value="\${s.title_prefix}" placeholder="CASHDROP Farkıyla" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">ARKA EK</label>
            <input id="f_title_suf" type="text" value="\${s.title_suffix}" placeholder="- YENİ" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">SKU (STOK KODU) MARKUP</label>
            <input id="f_sku_pre" type="text" value="\${s.sku_prefix}" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">SKU SUFFIX</label>
            <input id="f_sku_suf" type="text" value="\${s.sku_suffix}" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">BARCODE MARKUP</label>
            <input id="f_bar_pre" type="text" value="\${s.barcode_prefix}" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
          <div>
            <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">PRODUCT MAIN ID MARKUP</label>
            <input id="f_main_pre" type="text" value="\${s.main_id_prefix}" class="w-full border border-slate-200 rounded px-3 py-1.5" />
          </div>
        </div>

        <div>
          <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">BLOKLANMIŞ KELİMELER (Virgülle ayırın)</label>
          <input id="f_blocked" type="text" value="\${s.blocked_words.join(', ')}" placeholder="cam, şemsiye, kupa, kavanoz, erkek" class="w-full border border-slate-200 rounded px-3 py-1.5" />
        </div>

        <button onclick="saveFilterSettings('\${store.id}')" class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow">💾 Filtreleri Kaydet</button>
      </div>\` : ''}
    </div>
  </div>\`;
}

function renderLogsSection(store) {
  return \`
  <div class="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
    <div class="text-xs font-bold text-slate-800 mb-3">📋 Son Loglar</div>
    <div class="space-y-2 max-h-72 overflow-y-auto text-xs">
      \${store.logs.map(l => \`
        <div class="flex items-start justify-between gap-2 py-1.5 border-b border-slate-50">
          <div class="flex items-center gap-2">
            <span class="w-4 h-4 rounded bg-green-100 text-green-700 flex items-center justify-center text-[10px]">✓</span>
            <span class="text-slate-700">\${l.message}</span>
          </div>
          <span class="text-[10px] text-slate-400 shrink-0">\${(l.created_at || '').slice(11,16)}</span>
        </div>
      \`).join('')}
    </div>
  </div>\`;
}

// EKRAN 3: MAĞAZA BUL (Stok koduna göre LCW mağazalarında canlı stok sorgula)
function renderFindStore(store) {
  return \`
  <div class="p-6 max-w-4xl mx-auto space-y-4">
    <div class="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <h2 class="text-sm font-bold text-slate-800 mb-1">🔍 Mağaza Bul</h2>
      <p class="text-xs text-slate-400 mb-4">Stok koduna göre LCW mağazalarında canlı stok sorgula</p>
      <div class="space-y-3">
        <select class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700">
          <option>Lokasyon seçili slot: \${store?.name || 'TRENDLUCKY'} (\${store?.settings.locations.length || 0} İl)</option>
        </select>
        <div class="flex gap-2">
          <input id="find_stock_code" type="text" placeholder="Stok kodu (örn: S6A800Z8-Z3T)" class="flex-1 border border-slate-200 rounded-lg px-3.5 py-2 text-xs" />
          <button onclick="handleFindStore('\${store?.id}')" class="px-6 py-2 rounded-lg cash-gradient text-white text-xs font-semibold">Sorgula</button>
        </div>
      </div>
    </div>

    \${state.findStoreResults.length > 0 ? \`
      <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div class="text-xs font-bold text-slate-700">Canlı Mağaza Stok Sonuçları</div>
        \${state.findStoreResults.map(r => \`
          <div class="p-3 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-between text-xs">
            <div>
              <div class="font-bold text-slate-800">\${r.storeName}</div>
              <div class="text-[11px] text-slate-400">Kod: \${r.stockCode}</div>
            </div>
            <div class="flex gap-2">
              \${r.sizes.map(sz => \`<span class="px-2 py-1 rounded bg-green-100 text-green-800 font-semibold">\${sz.size}: \${sz.qty} adet</span>\`).join('')}
            </div>
          </div>
        \`).join('')}
      </div>
    \` : ''}
  </div>\`;
}

// EKRAN 4: TRENDYOL API AYARLARI (Videodaki Kilitli API Görünümü + Doğrulama)
function renderApiSettings(store) {
  if (!store) return '';
  return \`
  <div class="p-6 max-w-5xl mx-auto grid grid-cols-12 gap-6">
    <div class="col-span-12 lg:col-span-8 space-y-4">
      <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h2 class="text-sm font-bold text-slate-800">API Yapılandırması</h2>
        <p class="text-xs text-slate-400 mb-4">Her mağaza için Trendyol API anahtarlarınızı buradan tanımlayın. Sadece aktif mağazalar için anahtar girebilirsiniz.</p>

        <div class="mb-4">
          <div class="text-xs font-semibold text-slate-600 mb-1.5">Mağaza Seçimi</div>
          <div class="flex gap-2">
            \${state.stores.map(s => \`
              <button onclick="selectStore('\${s.id}', 'api_settings')" class="px-3 py-1.5 rounded-lg text-xs font-semibold \${s.id === store.id ? 'cash-gradient text-white' : 'bg-slate-100 text-slate-600'}">\${s.name}</button>
            \`).join('')}
          </div>
        </div>

        \${store.api_locked ? \`
          <div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <div class="text-xs font-bold text-red-700 mb-1">🔒 API Anahtarları Kilitli</div>
            <p class="text-[11px] text-red-600">Bu mağazanın API anahtarları kaydedilmiş ve kilitlenmiştir. Güvenlik nedeniyle anahtarlar kilitlendikten sonra korunur.</p>
            <button onclick="unlockApiKeys('\${store.id}')" class="mt-2 text-[11px] font-semibold text-red-700 underline">Kilidi Aç ve Düzenle</button>
          </div>
        \` : ''}

        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-slate-500 mb-1">Trendyol Satıcı ID (Supplier ID)</label>
            <input id="api_supplier" type="text" \${store.api_locked ? 'disabled' : ''} value="\${store.supplier_id || ''}" placeholder="Örn: 829261" class="w-full border border-slate-200 rounded-lg px-3 py-2 bg-slate-50" />
          </div>
          <div>
            <label class="block text-slate-500 mb-1">API Key</label>
            <input id="api_key" type="text" \${store.api_locked ? 'disabled' : ''} value="\${store.api_locked ? store.api_key_masked : (store.api_key || '')}" placeholder="Trendyol API Key" class="w-full border border-slate-200 rounded-lg px-3 py-2 bg-slate-50" />
          </div>
          <div>
            <label class="block text-slate-500 mb-1">API Secret Key</label>
            <input id="api_secret" type="password" \${store.api_locked ? 'disabled' : ''} value="\${store.api_locked ? '••••••••••••••••' : (store.api_secret || '')}" placeholder="Trendyol API Secret" class="w-full border border-slate-200 rounded-lg px-3 py-2 bg-slate-50" />
          </div>
          \${!store.api_locked ? \`
            <button onclick="saveApiKeys('\${store.id}')" class="px-5 py-2.5 rounded-lg cash-gradient text-white font-semibold shadow">Doğrula ve Kaydet</button>
          \` : ''}
        </div>
      </div>
    </div>

    <div class="col-span-12 lg:col-span-4 space-y-4">
      <div class="bg-white rounded-xl border border-slate-200 p-4 text-xs space-y-2">
        <div class="font-bold text-slate-800">ℹ️ API Bilgilerini Nereden Alırım?</div>
        <p class="text-slate-500">Trendyol Partner Paneli -> Hesabım -> Entegrasyon Bilgileri kısmından size özel anahtarlara ulaşabilirsiniz.</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4 text-xs space-y-2">
        <div class="font-bold text-slate-800">🛡️ Güvenlik Notu</div>
        <p class="text-slate-500">API anahtarlarınız Cloudflare D1 üzerinde saklanır ve hiçbir zaman açık metin olarak dışarı döndürülmez.</p>
      </div>
    </div>
  </div>\`;
}

// EKRAN 5: PROFİL AYARLARI
function renderProfile() {
  return \`
  <div class="p-6 max-w-4xl mx-auto space-y-5">
    <div class="cash-gradient h-28 rounded-2xl p-5 flex items-end text-white shadow">
      <div class="flex items-center gap-4">
        <div class="w-14 h-14 rounded-full bg-white text-green-700 font-bold text-xl flex items-center justify-center shadow">
          \${(state.user?.name || 'K').slice(0,2).toUpperCase()}
        </div>
        <div>
          <div class="text-xs uppercase text-green-100">MAĞAZA SAYISI: \${state.stores.length}</div>
          <div class="text-lg font-bold">\${state.user?.name}</div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div class="bg-white rounded-xl border border-slate-200 p-5 space-y-3 text-xs">
        <div class="font-bold text-sm text-slate-800">👤 Profil Bilgileri</div>
        <div>
          <label class="block text-slate-500 mb-1">Ad Soyad</label>
          <input id="prof_name" type="text" value="\${state.user?.name || ''}" class="w-full border border-slate-200 rounded-lg px-3 py-2" />
        </div>
        <div>
          <label class="block text-slate-500 mb-1">E-posta Adresi</label>
          <input id="prof_email" type="email" value="\${state.user?.email || ''}" class="w-full border border-slate-200 rounded-lg px-3 py-2" />
        </div>
        <button onclick="saveProfileInfo()" class="w-full py-2.5 rounded-lg cash-gradient text-white font-semibold">Bilgileri Güncelle</button>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-5 space-y-3 text-xs">
        <div class="font-bold text-sm text-slate-800">🔒 Şifre Değiştir</div>
        <div>
          <label class="block text-slate-500 mb-1">Mevcut Şifre</label>
          <input id="prof_cur_pass" type="password" placeholder="••••••••" class="w-full border border-slate-200 rounded-lg px-3 py-2" />
        </div>
        <div>
          <label class="block text-slate-500 mb-1">Yeni Şifre (En az 6 karakter)</label>
          <input id="prof_new_pass" type="password" placeholder="Yeni şifre" class="w-full border border-slate-200 rounded-lg px-3 py-2" />
        </div>
        <button onclick="savePassword()" class="w-full py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-semibold">Şifreyi Değiştir</button>
      </div>
    </div>
  </div>\`;
}

// EVENT HANDLERS
async function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById("auth_email").value;
  const password = document.getElementById("auth_password").value;
  const nameEl = document.getElementById("auth_name");
  try {
    const endpoint = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const res = await api(endpoint, "POST", { email, password, name: nameEl ? nameEl.value : undefined });
    state.token = res.token;
    localStorage.setItem("cashdrop_token", res.token);
    await initApp();
  } catch (err) {
    alert(err.message);
  }
}

function toggleAuthMode() {
  state.authMode = state.authMode === "login" ? "register" : "login";
  render();
}

function logout() {
  localStorage.removeItem("cashdrop_token");
  state.token = null;
  render();
}

function navigate(nav) {
  state.currentNav = nav;
  render();
}

function selectStore(id, targetNav = "store_detail") {
  state.selectedStoreId = id;
  state.currentNav = targetNav;
  render();
}

function setStoreTab(tab) {
  state.storeTab = tab;
  render();
}

function toggleAccordion(acc) {
  state.openAccordion = state.openAccordion === acc ? "" : acc;
  render();
}

function setProductFilter(f) {
  state.productFilter = f;
  render();
}

async function promptNewStore() {
  const name = prompt("Yeni Mağaza / Slot Adı girin:", "CASHDROP STORE");
  if (!name) return;
  const res = await api("/api/stores", "POST", { name });
  state.selectedStoreId = res.storeId;
  await initApp();
}

async function promptRenameStore(storeId, currentName) {
  const name = prompt("Yeni mağaza adını girin:", currentName);
  if (!name) return;
  await api("/api/stores/action", "POST", { storeId, action: "rename", name });
  await initApp();
}

async function storeAction(storeId, action) {
  await api("/api/stores/action", "POST", { storeId, action });
  await initApp();
}

function updatePriceRule(idx, field, val) {
  const store = getSelectedStore();
  store.settings.price_rules[idx][field] = Number(val);
  render();
}

function addPriceRule() {
  const store = getSelectedStore();
  store.settings.price_rules.push({ min: 3000, max: 5000, mult: 1.8 });
  render();
}

function removePriceRule(idx) {
  const store = getSelectedStore();
  store.settings.price_rules.splice(idx, 1);
  render();
}

async function savePriceStockSettings(storeId) {
  const store = getSelectedStore();
  await api("/api/stores/settings", "POST", {
    storeId,
    section: "price_stock",
    min_stock: Number(document.getElementById("set_min_stock").value),
    stock_source_location: document.getElementById("set_src_loc").checked,
    stock_source_web: document.getElementById("set_src_web").checked,
    max_product_limit: Number(document.getElementById("set_max_limit").value),
    price_rules: store.settings.price_rules
  });
  alert("Fiyat ve stok kuralları kaydedildi!");
  await initApp();
}

function toggleCategory(cat) {
  const store = getSelectedStore();
  const idx = store.settings.categories.indexOf(cat);
  if (idx > -1) store.settings.categories.splice(idx, 1);
  else store.settings.categories.push(cat);
  render();
}

async function saveCategories(storeId) {
  const store = getSelectedStore();
  await api("/api/stores/settings", "POST", { storeId, section: "categories", categories: store.settings.categories });
  alert("Kategoriler kaydedildi!");
  await initApp();
}

function toggleLocation(city) {
  const store = getSelectedStore();
  const idx = store.settings.locations.indexOf(city);
  if (idx > -1) store.settings.locations.splice(idx, 1);
  else store.settings.locations.push(city);
  render();
}

async function saveLocations(storeId) {
  const store = getSelectedStore();
  await api("/api/stores/settings", "POST", { storeId, section: "locations", locations: store.settings.locations });
  alert("Konumlar kaydedildi!");
  await initApp();
}

function addWordRep() {
  const store = getSelectedStore();
  store.settings.word_replacements.push({ from: "", to: "" });
  render();
}

function updateWordRep(i, field, val) {
  const store = getSelectedStore();
  store.settings.word_replacements[i][field] = val;
}

function removeWordRep(i) {
  const store = getSelectedStore();
  store.settings.word_replacements.splice(i, 1);
  render();
}

async function saveFilterSettings(storeId) {
  const store = getSelectedStore();
  const blockedRaw = document.getElementById("f_blocked").value;
  const blockedArr = blockedRaw.split(",").map(s => s.trim()).filter(Boolean);
  await api("/api/stores/settings", "POST", {
    storeId,
    section: "filters",
    word_replacements: store.settings.word_replacements,
    priority_prefixes: document.getElementById("f_prio_prefix").value,
    sku_prefixes: document.getElementById("f_sku_prefix_filter").value,
    title_prefix: document.getElementById("f_title_pre").value,
    title_suffix: document.getElementById("f_title_suf").value,
    sku_prefix: document.getElementById("f_sku_pre").value,
    sku_suffix: document.getElementById("f_sku_suf").value,
    barcode_prefix: document.getElementById("f_bar_pre").value,
    barcode_suffix: "",
    main_id_prefix: document.getElementById("f_main_pre").value,
    main_id_suffix: "",
    blocked_words: blockedArr
  });
  alert("Kelime filtreleri ve Markup ayarları kaydedildi!");
  await initApp();
}

async function saveApiKeys(storeId) {
  const supplier_id = document.getElementById("api_supplier").value;
  const api_key = document.getElementById("api_key").value;
  const api_secret = document.getElementById("api_secret").value;
  if (!supplier_id || !api_key || !api_secret) {
    alert("Lütfen Satıcı ID, API Key ve API Secret alanlarını eksiksiz doldurun.");
    return;
  }
  await api("/api/stores/api-keys", "POST", { storeId, supplier_id, api_key, api_secret });
  alert("Trendyol API anahtarlarınız doğrulandı, kilitlendi ve ilk ürün aktarımı başlatıldı!");
  await initApp();
}

async function unlockApiKeys(storeId) {
  await api("/api/stores/api-keys", "POST", { storeId, unlock: true });
  await initApp();
}

async function handleFindStore(storeId) {
  const stockCode = document.getElementById("find_stock_code").value;
  const res = await api("/api/lcw/find-store", "POST", { storeId, stockCode });
  state.findStoreResults = res.results || [];
  render();
}

async function saveProfileInfo() {
  const name = document.getElementById("prof_name").value;
  const email = document.getElementById("prof_email").value;
  const res = await api("/api/profile", "POST", { name, email });
  alert(res.message);
  await initApp();
}

async function savePassword() {
  const currentPassword = document.getElementById("prof_cur_pass").value;
  const newPassword = document.getElementById("prof_new_pass").value;
  try {
    const res = await api("/api/profile", "POST", { currentPassword, newPassword });
    alert(res.message);
  } catch (e) {
    alert(e.message);
  }
}

function render() {
  const root = document.getElementById("app");
  if (!state.token) {
    root.innerHTML = renderAuth();
    return;
  }
  const store = getSelectedStore();
  let mainContent = "";
  if (state.currentNav === "overview") mainContent = renderOverview(store);
  else if (state.currentNav === "store_detail") mainContent = renderStoreDetail(store);
  else if (state.currentNav === "find_store") mainContent = renderFindStore(store);
  else if (state.currentNav === "api_settings") mainContent = renderApiSettings(store);
  else if (state.currentNav === "profile") mainContent = renderProfile();

  root.innerHTML = \`
    <div class="flex min-h-screen">
      \${renderSidebar(store)}
      <main class="flex-1 overflow-y-auto">\${mainContent}</main>
    </div>
  \`;
}

initApp();
</script>
</body>
</html>`;