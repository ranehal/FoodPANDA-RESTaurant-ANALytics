import os, sys, json, glob
from datetime import datetime, timezone
import duckdb

DATA_DIR = r"C:\PROJECTS\ShopGOD\FoodPANDA"
HIST_DIR = os.path.join(DATA_DIR, "history")
DATA_FILE = os.path.join(DATA_DIR, "restaurant_dashboard", "data.json")
PARQUET_FILE = os.path.join(DATA_DIR, "restaurant_dashboard", "data.parquet")

print("1. Loading complete price trajectories across all 34 daily snapshots...")
hist_files = sorted(glob.glob(os.path.join(HIST_DIR, "*.json")))
print(f"   Found {len(hist_files)} snapshot files.")

existing_dish_hist = {}
date_set = set()

for f in hist_files:
    fname = os.path.basename(f)
    date_part = fname.replace(".json", "").split("_")[-1]
    date_set.add(date_part)
    try:
        with open(f, "r", encoding="utf-8") as fh:
            h_data = json.load(fh)
        locs = h_data.get("locations", [])
        for loc in locs:
            for rest in loc.get("restaurants", []):
                rid = str(rest.get("id") or rest.get("code") or "")
                for did, menu in rest.get("menus", {}).items():
                    key = f"{rid}:{did}"
                    p_hist = menu.get("priceHistory") or menu.get("price_history") or menu.get("history") or []
                    if isinstance(p_hist, list) and p_hist:
                        for entry in p_hist:
                            if isinstance(entry, dict) and entry.get("date"):
                                if key not in existing_dish_hist:
                                    existing_dish_hist[key] = []
                                if not any(h.get("date") == entry.get("date") for h in existing_dish_hist[key]):
                                    existing_dish_hist[key].append(entry)
                    else:
                        try: p = float(menu.get("price", 0))
                        except: p = 0
                        if p > 0:
                            if key not in existing_dish_hist:
                                existing_dish_hist[key] = []
                            if not any(h.get("date") == date_part for h in existing_dish_hist[key]):
                                existing_dish_hist[key].append({
                                    "date": date_part,
                                    "price": p,
                                    "oldPrice": float(menu.get("oldPrice", p) or p)
                                })
    except Exception as e:
        print(f"   Error reading {fname}: {e}")

for k in existing_dish_hist:
    existing_dish_hist[k].sort(key=lambda x: str(x.get("date", "")))

sorted_dates = sorted(list(date_set))
print(f"   Total tracked unique dishes: {len(existing_dish_hist)}")
print(f"   Dates covered ({len(sorted_dates)} days): {sorted_dates[0]} to {sorted_dates[-1]}")
multi_day_dishes = sum(1 for h in existing_dish_hist.values() if len(h) > 1)
max_points = max(len(h) for h in existing_dish_hist.values()) if existing_dish_hist else 0
print(f"   Dishes with multi-day history: {multi_day_dishes}")
print(f"   Max historical points for a single dish: {max_points}")

# 2. Re-attach history to the latest master snapshot (2026-08-31)
latest_file = os.path.join(HIST_DIR, "foodpanda_restaurants_2026-08-31.json")
with open(latest_file, "r", encoding="utf-8") as lf:
    latest_data = json.load(lf)

latest_locations = latest_data.get("locations", [])
total_attached = 0
for loc in latest_locations:
    for rest in loc.get("restaurants", []):
        rid = str(rest.get("id") or rest.get("code") or "")
        for did, menu in rest.get("menus", {}).items():
            key = f"{rid}:{did}"
            if key in existing_dish_hist:
                menu["priceHistory"] = existing_dish_hist[key]
                total_attached += 1

print(f"2. Attached history to latest snapshot: {total_attached} dishes updated.")

latest_data["totalRestaurants"] = sum(len(l["restaurants"]) for l in latest_locations)
latest_data["totalDishes"] = sum(len(r.get("menus", {})) for l in latest_locations for r in l["restaurants"])
scraped_at = latest_data.get("scrapedAt", "2026-08-31T12:00:00+00:00")

# 3. Save data.json
with open(DATA_FILE, "w", encoding="utf-8") as f:
    json.dump(latest_data, f, ensure_ascii=False)
print(f"3. Saved {DATA_FILE} ({os.path.getsize(DATA_FILE)/(1024*1024):.2f} MB)")

# 4. Save data.parquet using pyarrow with zstd 19
print("4. Serializing data.parquet with embedded d_history JSON strings...")
import pyarrow as pa
import pyarrow.parquet as pq

rows = []
for loc in latest_locations:
    loc_name = loc.get("name", "")
    loc_lat = loc.get("lat", 0)
    loc_lng = loc.get("lng", 0)

    for rest in loc.get("restaurants", []):
        menus = rest.get("menus", {})
        base = {
            "meta_scraped_at": scraped_at,
            "loc_name": loc_name,
            "loc_lat": loc_lat,
            "loc_lng": loc_lng,
            "r_id": rest.get("id", 0),
            "r_code": rest.get("code", ""),
            "r_name": rest.get("name", ""),
            "r_image": rest.get("image", ""),
            "r_cuisines": json.dumps(rest.get("cuisineList", []), ensure_ascii=False),
            "r_cuisineObjects": json.dumps(rest.get("cuisineObjects", []), ensure_ascii=False),
            "r_primary": rest.get("primaryCuisine", ""),
            "r_rating": float(rest.get("rating", 0)),
            "r_reviews": int(rest.get("reviewCount", 0)),
            "r_delivery": int(rest.get("deliveryTime", 0)),
            "r_deliveryMax": int(rest.get("deliveryTimeMax", 0)),
            "r_deliveryText": rest.get("deliveryTimeText", ""),
            "r_dist": float(rest.get("distance", 0)),
            "r_minOrder": float(rest.get("minimumOrder", 0)),
            "r_delFee": float(rest.get("deliveryFee", 0)),
            "r_budget": int(rest.get("budget", 0)),
            "priceRange": rest.get("priceRange", ""),
            "r_discount": bool(rest.get("hasDiscount", False)),
            "r_discountTags": json.dumps(rest.get("discountTags", []), ensure_ascii=False),
            "r_lat": float(rest.get("latitude", 0)),
            "r_lng": float(rest.get("longitude", 0)),
            "r_active": bool(rest.get("isActive", False)),
            "r_delEnabled": bool(rest.get("isDeliveryEnabled", False)),
            "r_preorder": bool(rest.get("isPreorderEnabled", False)),
            "r_webPath": rest.get("webPath", ""),
            "r_redirect": rest.get("redirectionUrl", ""),
            "r_popular": bool(rest.get("isPopular", False)),
            "r_new": bool(rest.get("isNew", False)),
            "r_verticalType": json.dumps(rest.get("verticalType", []), ensure_ascii=False),
            "r_categories": json.dumps(rest.get("categories", []), ensure_ascii=False),
            "r_minOrderVal": float(rest.get("minOrderValue", 0)),
            "r_prepTime": int(rest.get("preparationTime", 0)),
            "r_workHours": json.dumps(rest.get("workingHours", {}), ensure_ascii=False),
        }

        if not menus:
            rows.append({**base, "d_id": None, "d_name": None, "d_price": 0.0, "d_oldPrice": 0.0, "d_desc": None, "d_image": None, "d_avail": None, "d_popular": None, "d_cat": None, "d_rating": 0.0, "d_history": None})
        else:
            for dish in menus.values():
                p_hist = dish.get("priceHistory") or []
                rows.append({
                    **base,
                    "d_id": str(dish.get("id", "")),
                    "d_name": str(dish.get("name", "")),
                    "d_price": float(dish.get("price", 0)),
                    "d_oldPrice": float(dish.get("oldPrice", 0)),
                    "d_desc": str(dish.get("description", "")),
                    "d_image": str(dish.get("image", "")),
                    "d_avail": bool(dish.get("isAvailable", False)),
                    "d_popular": bool(dish.get("isPopular", False)),
                    "d_cat": str(dish.get("category", "")),
                    "d_rating": float(dish.get("rating", 0)),
                    "d_history": json.dumps(p_hist, separators=(',', ':'), ensure_ascii=False) if p_hist else None,
                })

table = pa.Table.from_pylist(rows)
pq.write_table(table, PARQUET_FILE, compression="zstd", compression_level=19)
print(f"4. Saved {PARQUET_FILE} ({os.path.getsize(PARQUET_FILE)/(1024*1024):.2f} MB)")
print("Rebuild complete!")
