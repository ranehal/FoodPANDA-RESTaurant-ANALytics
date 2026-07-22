"""
FoodPANDA Live Scraper - Fetches restaurants + menus from Foodpanda API.
Uses offers-zone REST endpoint for listing and GraphQL for details.
Usage: python scrape_menus.py [--token JWT_TOKEN] [--limit N] [--skip-details]
"""

import httpx
import json
import time
import random
import os
import sys
import argparse
from datetime import datetime, timezone

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DATA_DIR, "restaurant_dashboard", "data.json")
PARQUET_FILE = os.path.join(DATA_DIR, "restaurant_dashboard", "data.parquet")
TOKEN_FILE = os.path.join(DATA_DIR, "data", "token.txt")

BASE_URL = "https://bd.fd-api.com"

HEADERS_BASE = {
    "accept": "application/json",
    "accept-charset": "UTF-8",
    "accept-encoding": "gzip",
    "content-type": "application/json; charset=utf-8",
    "app-version": "26.28.0",
    "device-id": "24de6ba6fb091a6d4a82735d73e61a05",
    "user-agent": "Android-app-26.28.0(262800214)",
    "x-fp-api-key": "android",
    "app-name": "com.global.foodpanda.android",
    "app-flavor": "foodpanda",
    "platform": "android",
    "platform-version": "36",
    "build-type": "release",
    "api-client-version": "5.0",
    "x-pd-language-id": "1",
}

LOCATIONS = [
    {"name": "Dhanmondi", "lat": 23.7465, "lng": 90.3742},
    {"name": "Gulshan", "lat": 23.7925, "lng": 90.4078},
    {"name": "Banani", "lat": 23.7936, "lng": 90.4023},
    {"name": "Uttara", "lat": 23.8759, "lng": 90.4000},
    {"name": "Mirpur", "lat": 23.8042, "lng": 90.3526},
]

PAGE_SIZE = 40
REQUEST_DELAY = 0.5
MAX_RETRIES = 3

GRAPHQL_HASH = "e54e2da1664dea317275ce6c580b6a38b06b6a2bdf446fa1be878652a4883063"


def fetch_fresh_token():
    """Fetch a fresh guest token from the OAuth2 endpoint."""
    url = f"{BASE_URL}/api/v5/oauth2/token?language_id=1"
    body = "grant_type=client_credentials&client_secret=xvvebcx9ahww0scwkogwc8g8gs8wc4gow8s0sckw0k4s4s00c&scope=API_CUSTOMER&client_id=android"
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Android-app-26.28.0(262800214)",
        "app-version": "26.28.0",
        "device-id": "24de6ba6fb091a6d4a82735d73e61a05",
        "app-name": "com.global.foodpanda.android",
        "app-flavor": "foodpanda",
        "platform": "android",
        "platform-version": "36",
        "build-type": "release",
        "api-client-version": "5.0",
        "x-pd-language-id": "1",
        "x-fp-api-key": "android",
    }
    try:
        with httpx.Client(http2=False) as c:
            r = c.post(url, content=body, headers=headers, timeout=15)
            if r.status_code == 200:
                data = r.json()
                token = data.get("access_token", "")
                if token:
                    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
                    with open(TOKEN_FILE, "w") as f:
                        f.write(token)
                    return token
    except Exception as ex:
        print(f"  [auth] Failed to fetch fresh token: {ex}")
    return None


def make_auth_headers(token):
    headers = {**HEADERS_BASE}
    headers["authorization"] = f"Bearer {token}"
    return headers


def make_client():
    """Create a fresh HTTP client."""
    return httpx.Client(http2=True, follow_redirects=True)


def fetch_restaurant_listing(client, token, lat, lng, offset=0, limit=PAGE_SIZE):
    """Fetch restaurant listing from offers-zone endpoint."""
    url = f"{BASE_URL}/offers-zone/api/v2/offers-zone?language_id=1"
    body = {
        "vertical": "restaurants",
        "expedition": "delivery",
        "latitude": str(lat),
        "longitude": str(lng),
        "offset": str(offset),
        "limit": str(limit),
        "language_code": "en_BD",
        "include": "ui_config,vendor_list,personalized_swimlane,seasonal_carousel",
        "customer_type": "b2c",
        "tag_label_metadata": "false",
        "use_free_delivery_label": "true",
        "device_type": "android",
        "client_version": "26.28.0",
    }
    headers = make_auth_headers(token)

    r = client.post(url, json=body, headers=headers, timeout=20)

    if r.status_code == 401:
        return None, "unauthorized"

    if r.status_code != 200:
        print(f"  [list] HTTP {r.status_code}: {r.text[:200]}")
        return None, f"http_{r.status_code}"

    data = r.json()
    if "data" not in data or "vendor_list" not in data["data"]:
        return None, "no_data"

    vl = data["data"]["vendor_list"]
    items = vl.get("items", [])
    total = vl.get("available_count", 0)

    return {"items": items, "total": total}, "ok"


def fetch_restaurant_detail(client, vendor_code, token, lat, lng):
    """Fetch restaurant detail via GraphQL RestaurantDetailsPage."""
    variables = json.dumps({
        "input": {
            "code": vendor_code,
            "expeditionType": "DELIVERY",
            "filters": {"productRecommendationLimit": -1},
            "isPandaboost": False,
            "ignoreShrinkage": False,
        },
        "isRetrieveIdOnly": True,
        "isVendorMiscEnabled": True,
        "menuInput": {"expeditionType": "DELIVERY"},
        "isPickup": False,
        "mfoFederationEnabled": False,
        "isShrinkageUseCase": False,
        "recommendationInput": {
            "expeditionType": "DELIVERY",
            "isMealForOne": False,
        },
        "discountedPriceInput": {"expeditionType": "DELIVERY"},
    })
    extensions = json.dumps({
        "persistedQuery": {
            "version": 1,
            "sha256Hash": GRAPHQL_HASH,
        }
    })

    url = f"{BASE_URL}/graphql"
    params = {
        "operationName": "RestaurantDetailsPage",
        "variables": variables,
        "extensions": extensions,
    }
    headers = make_auth_headers(token)
    headers["apollo-require-preflight"] = "true"
    headers["x-apollo-operation-name"] = "RestaurantDetailsPage"
    headers["display-context"] = "RDP"
    headers["customer-latitude"] = str(lat)
    headers["customer-longitude"] = str(lng)
    headers["perseus-client-id"] = f"{int(time.time()*1000)}.{random.randint(10**9,10**10-1)}.{random.randint(10**19,10**20-1)}"
    headers["perseus-session-id"] = f"{int(time.time()*1000)}.{random.randint(10**19,10**20-1)}.{random.randint(10**19,10**20-1)}"
    headers["dps-session-id"] = json.dumps({"session_id": f"{random.randint(10**21,10**22-1):x}", "timestamp": int(time.time()*1000)})
    headers["locale"] = "en_BD"
    headers["x-global-entity-id"] = "FP_BD"
    headers["apollographql-client-name"] = "android"
    headers["apollographql-client-version"] = "26.28.0"

    r = client.get(url, params=params, headers=headers, timeout=20)

    if r.status_code == 401:
        return None, "unauthorized"

    if r.status_code != 200:
        return None, f"http_{r.status_code}"

    data = r.json()
    rdp = data.get("data", {}).get("restaurantDetailsPage")
    if rdp:
        return rdp, "ok"

    errors = data.get("errors", [])
    for e in errors:
        msg = e.get("message", "")
        if "401" in msg or "expired" in msg or "invalid" in msg.lower() or "OAuthFailed" in msg:
            return None, "unauthorized"
    return None, "no_data"


def parse_vendor_list_item(item):
    """Parse a vendor list item into our standard restaurant format."""
    delivery_time = item.get("delivery_time", {})
    duration = item.get("delivery_duration_range", {})
    cuisines = item.get("characteristics", {}).get("cuisines", [])

    delivery_min = duration.get("lower_limit_in_minutes") or item.get("minimum_delivery_time", 0)
    delivery_max = duration.get("upper_limit_in_minutes", 0)

    budget = item.get("budget", 0)
    rating = item.get("rating", 0)
    review_count = item.get("review_number", 0)

    tags = item.get("tags", [])
    has_discount = item.get("metadata", {}).get("has_discount", False)

    hero = item.get("hero_listing_image") or item.get("hero_image", "")
    if not hero and item.get("code"):
        hero = f"https://images.deliveryhero.io/image/fd-bd/LH/{item['code']}-listing.jpg"

    return {
        "id": item.get("id", 0),
        "code": item.get("code", ""),
        "name": item.get("name", ""),
        "image": hero,
        "cuisineList": [c["name"] for c in cuisines if c.get("name")],
        "cuisineObjects": cuisines,
        "primaryCuisine": next((c["name"] for c in cuisines if c.get("main")), ""),
        "rating": rating,
        "reviewCount": review_count,
        "deliveryTime": delivery_min,
        "deliveryTimeMax": delivery_max,
        "deliveryTimeText": delivery_time.get("text", ""),
        "distance": item.get("distance", 0),
        "minimumOrder": item.get("minimum_order_amount", 0),
        "deliveryFee": item.get("original_delivery_fee", 0),
        "budget": budget,
        "priceRange": "$" * budget if budget else "",
        "hasDiscount": has_discount,
        "discountTags": [{"code": t.get("code"), "text": t.get("text")} for t in tags],
        "latitude": item.get("latitude", 0),
        "longitude": item.get("longitude", 0),
        "isActive": item.get("is_active", False),
        "isDeliveryEnabled": item.get("is_delivery_enabled", False),
        "isPreorderEnabled": item.get("is_preorder_enabled", False),
        "webPath": item.get("web_path", ""),
        "redirectionUrl": item.get("redirection_url", ""),
        "isPopular": any(t.get("code") == "POPULAR" for t in tags),
        "isNew": any(t.get("code") == "NEW" for t in tags),
        "verticalType": item.get("vertical_type", []),
        "categories": [],
        "menus": {},
        "minOrderValue": item.get("minimum_order_amount", 0),
        "preparationTime": 0,
        "workingHours": {},
    }


def parse_graphql_detail(data):
    """Parse GraphQL RestaurantDetailsPage response."""
    if not data:
        return {}

    vd = data.get("vendorData", {})
    menu = vd.get("menu") or {}
    categories_data = menu.get("categories", [])

    categories = []
    menus = {}

    for cat in categories_data:
        cat_name = cat.get("title", "")
        cat_id = cat.get("id", "")
        categories.append({
            "id": cat_id,
            "name": cat_name,
        })

        for prod in cat.get("products", []):
            pid = prod.get("id", "")
            title = prod.get("title", "")
            pa = prod.get("priceAttributes", {})
            price = pa.get("originalPrice", 0)
            discounted = pa.get("discountedPrice")
            img_obj = prod.get("image", {})
            img_url = img_obj.get("url", "") if isinstance(img_obj, dict) else str(img_obj)
            rating_obj = prod.get("rating") or {}
            rating_pct = rating_obj.get("percentage", 0) if isinstance(rating_obj, dict) else 0

            menus[str(pid)] = {
                "id": pid,
                "name": title,
                "price": price,
                "oldPrice": discounted if discounted else 0,
                "description": prod.get("description", ""),
                "image": img_url,
                "isAvailable": not prod.get("isSoldOut", False),
                "isPopular": prod.get("isBundle", False),
                "category": cat_name,
                "rating": rating_pct,
            }

    return {
        "categories": categories,
        "menus": menus,
        "minOrderValue": vd.get("minimumOrderValue", 0),
        "preparationTime": 0,
        "workingHours": {},
    }


def merge_detail(restaurant, detail):
    """Merge detail data into restaurant."""
    for key in ("categories", "menus", "minOrderValue", "preparationTime", "workingHours"):
        val = detail.get(key)
        if val is not None and val != "" and val != [] and val != {}:
            restaurant[key] = val


def save_output(locations):
    total_r = sum(len(loc["restaurants"]) for loc in locations)
    total_d = sum(
        len(r.get("menus", {}))
        for loc in locations
        for r in loc["restaurants"]
    )
    output = {
        "locations": locations,
        "totalRestaurants": total_r,
        "totalDishes": total_d,
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
    }
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    save_parquet(locations, total_r, total_d, output["scrapedAt"])
    return total_r, total_d


def save_parquet(locations, total_r, total_d, scraped_at):
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        print("  [parquet] pyarrow not installed — pip install pyarrow")
        return False

    rows = []
    for loc in locations:
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
                "r_priceRange": rest.get("priceRange", ""),
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
                rows.append({**base, "d_id": None, "d_name": None, "d_price": 0.0, "d_oldPrice": 0.0, "d_desc": None, "d_image": None, "d_avail": None, "d_popular": None, "d_cat": None, "d_rating": 0.0})
            else:
                for dish in menus.values():
                    rows.append({
                        **base,
                        "d_id": dish.get("id", 0),
                        "d_name": dish.get("name", ""),
                        "d_price": float(dish.get("price", 0)),
                        "d_oldPrice": float(dish.get("oldPrice", 0)),
                        "d_desc": dish.get("description", ""),
                        "d_image": dish.get("image", ""),
                        "d_avail": bool(dish.get("isAvailable", False)),
                        "d_popular": bool(dish.get("isPopular", False)),
                        "d_cat": dish.get("category", ""),
                        "d_rating": float(dish.get("rating", 0)),
                    })

    if not rows:
        print("  [parquet] No rows to write")
        return False

    table = pa.Table.from_pylist(rows)
    pq.write_table(table, PARQUET_FILE, compression="zstd", compression_level=19)

    if os.path.exists(PARQUET_FILE):
        json_size = os.path.getsize(DATA_FILE) / 1024
        parquet_size = os.path.getsize(PARQUET_FILE) / 1024
        ratio = (1 - parquet_size / json_size) * 100 if json_size > 0 else 0
        print(f"  [parquet] {parquet_size:.0f} KB (was {json_size:.0f} KB JSON, {ratio:.0f}% smaller)")
        return True
    return False


def main():
    parser = argparse.ArgumentParser(description="FoodPANDA Live Scraper")
    parser.add_argument("--token", help="JWT Bearer token")
    parser.add_argument("--limit", type=int, default=0, help="Max restaurants per location (0=all)")
    parser.add_argument("--skip-details", action="store_true", help="Skip GraphQL detail fetch (listings only)")
    args = parser.parse_args()

    print("=" * 60)
    print("  FoodPANDA Live Scraper")
    print("=" * 60)

    token = args.token
    if not token and os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
    if not token:
        token = fetch_fresh_token()
        if token:
            print("  [auth] Fetched fresh guest token")
        else:
            print("  [auth] WARNING: Could not fetch token")
            token = ""

    client = make_client()
    consecutive_auth_fails = 0
    output_locations = []
    total_restaurants = 0
    total_dishes = 0

    for loc in LOCATIONS:
        lat, lng = loc["lat"], loc["lng"]
        name = loc["name"]
        print(f"\n--- {name} (lat={lat}, lng={lng}) ---")

        all_vendors = []
        offset = 0

        while True:
            print(f"  [list] Fetching offset={offset}...")
            result, status = fetch_restaurant_listing(client, token, lat, lng, offset)

            if status == "unauthorized":
                print("  [auth] Token expired during listing, refreshing...")
                new_token = fetch_fresh_token()
                if new_token:
                    token = new_token
                    print("  [auth] Refreshed token, retrying...")
                    result, status = fetch_restaurant_listing(client, token, lat, lng, offset)
                if status != "ok":
                    print(f"  [list] Failed after refresh: {status}")
                    break

            if status != "ok" or not result:
                print(f"  [list] Failed: {status}")
                break

            items = result["items"]
            total_available = result["total"]
            all_vendors.extend(items)

            print(f"  [list] Got {len(items)} restaurants ({len(all_vendors)}/{total_available} total)")

            if len(all_vendors) >= total_available or len(items) == 0:
                break

            if args.limit > 0 and len(all_vendors) >= args.limit * 2:
                break

            offset += PAGE_SIZE
            time.sleep(REQUEST_DELAY)

        if not all_vendors:
            print(f"  [SKIP] No restaurants found for {name}")
            continue

        restaurants = [parse_vendor_list_item(v) for v in all_vendors]

        if args.limit > 0:
            restaurants = restaurants[:args.limit]
            print(f"\n  [limit] Trimmed to {len(restaurants)} restaurants")

        if args.skip_details:
            print(f"  [skip-details] Skipping menu fetch")
        else:
            print(f"\n  [detail] Fetching menus for {len(restaurants)} restaurants...")

        scraped = 0
        failed = 0
        auth_fails_this_loc = 0

        if not args.skip_details:
            for i, rest in enumerate(restaurants):
                code = rest["code"]
                rname = rest.get("name", code)

                detail = None
                for attempt in range(MAX_RETRIES):
                    try:
                        detail, dstatus = fetch_restaurant_detail(client, code, token, lat, lng)
                        if dstatus == "unauthorized":
                            auth_fails_this_loc += 1
                            if auth_fails_this_loc <= 3:
                                print(f"  [auth] Token expired, refreshing (attempt {attempt+1})...")
                                new_token = fetch_fresh_token()
                                if new_token:
                                    token = new_token
                                    try:
                                        client.close()
                                    except Exception:
                                        pass
                                    client = make_client()
                                    print("  [auth] Token refreshed, retrying...")
                                    continue
                                else:
                                    print("  [auth] Could not refresh token")
                            break
                        break
                    except (httpx.ReadError, httpx.ConnectError, httpx.RemoteProtocolError,
                            ConnectionResetError, OSError) as ex:
                        if attempt < MAX_RETRIES - 1:
                            wait = (attempt + 1) * 2
                            print(f"  [retry] Connection error ({type(ex).__name__}), waiting {wait}s...")
                            try:
                                client.close()
                            except Exception:
                                pass
                            client = make_client()
                            time.sleep(wait)
                        else:
                            print(f"  [ERROR] {rname}: {type(ex).__name__}: {ex}")
                            detail = None
                            break

                if detail:
                    parsed = parse_graphql_detail(detail)
                    merge_detail(rest, parsed)
                    dish_count = len(parsed.get("menus", {}))
                    scraped += 1
                    consecutive_auth_fails = 0
                    if dish_count > 0:
                        print(f"  [{i+1}/{len(restaurants)}] {rname}: {dish_count} dishes")
                    else:
                        print(f"  [{i+1}/{len(restaurants)}] {rname}: no menu data")
                else:
                    failed += 1
                    if auth_fails_this_loc > 3:
                        if failed <= 3 or failed % 20 == 0:
                            print(f"  [{i+1}/{len(restaurants)}] {rname}: FAIL (token expired, skipping rest)")
                        if auth_fails_this_loc > 5:
                            break
                    else:
                        print(f"  [{i+1}/{len(restaurants)}] {rname}: FAIL")

                time.sleep(REQUEST_DELAY)

                if (i + 1) % 30 == 0:
                    restaurants.sort(key=lambda r: r.get("distance") or 9999)
                    _loc = {"name": name, "lat": lat, "lng": lng, "restaurants": restaurants}
                    _locs = [l for l in output_locations if l["name"] != name] + [_loc]
                    save_output(_locs)

        loc_dishes = sum(len(r.get("menus", {})) for r in restaurants)
        total_restaurants += len(restaurants)
        total_dishes += loc_dishes

        restaurants.sort(key=lambda r: r.get("distance") or 9999)
        output_locations.append({
            "name": name,
            "lat": lat,
            "lng": lng,
            "restaurants": restaurants,
        })

        print(f"\n  {name} summary: {len(restaurants)} restaurants, {loc_dishes} dishes ({scraped} ok, {failed} failed)")

    try:
        client.close()
    except Exception:
        pass

    total_r, total_d = save_output(output_locations)

    print(f"\n{'=' * 60}")
    print(f"  DONE")
    print(f"  Restaurants: {total_r}")
    print(f"  Dishes:      {total_d}")
    for label, path in [("JSON", DATA_FILE), ("Parquet", PARQUET_FILE)]:
        if os.path.exists(path):
            print(f"  {label}:       {path} ({os.path.getsize(path) / 1024:.0f} KB)")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
