# AGENTS.md

## What this is
- ShopGOD scraper & intelligence dashboard project for **Foodpanda Bangladesh** (`bd.fd-api.com` / FoodPANDA restaurant menu & price tracker).
- Tracks restaurant menus, item prices, discount histories, and location-based coverage across Dhaka (Dhanmondi, Gulshan, Banani, Uttara, Mirpur).
- Core components:
  - `scrape_menus.py`: Live scraper fetching vendors from `/offers-zone/api/v2/offers-zone` and menu/pricing details via GraphQL `RestaurantDetailsPage` (`bd.fd-api.com/graphql`).
  - `restaurant_dashboard/`: Interactive liquid-glass web dashboard powered by `hyparquet` reading `data.parquet` (with JSON fallback to `data.json`).
  - `history/`: Daily JSON snapshots (`foodpanda_restaurants_YYYY-MM-DD.json`) preserving full multi-day menu price histories.
  - `data/token.txt`: Cached guest JWT authentication token.

## Git / Repo Rules
- Remote: `https://github.com/ranehal/FoodPANDA-RESTaurant-ANALytics.git` (branch `main`).
- Primary entry point is `scrape_menus.py` (NEVER run generic `scraper.py` or foreign scraper scripts in this repo).
- Do not commit large binary dumps (`*.apk`, `*.har`, `.venv/`, `__pycache__/`).
- `restaurant_dashboard/data.json` is tracked via Git LFS (`.gitattributes`) and can also be served via split chunks or compressed parquet. `data.parquet` is compressed with zstd level 19 for ultra-fast browser loading.

## Foodpanda API Architecture
- Base URL: `https://bd.fd-api.com`
- Auth: Guest tokens obtained via `POST /api/v5/oauth2/token?language_id=1` with `grant_type=client_credentials`.
- Listing: `GET /offers-zone/api/v2/offers-zone?latitude={lat}&longitude={lng}&language_id=1&offset={page*40}&limit=40`
- Menu & Pricing Details: `GET /graphql` with `operationName=RestaurantDetailsPage`, `extensions={"persistedQuery":{"version":1,"sha256Hash":"e54e2da1664dea317275ce6c580b6a38b06b6a2bdf446fa1be878652a4883063"}}`.
  - **Mandatory Headers**: `perseus-client-id`, `perseus-session-id`, `customer-latitude`, `customer-longitude`, `x-fp-api-key: android`, `authorization: Bearer {token}`.

## Daily History & Dataset
- `history/foodpanda_restaurants_YYYY-MM-DD.json`: Complete daily snapshots.
- `scrape_menus.py`'s `load_all_existing_history()` reads all files in `history/` to build multi-day price trajectories into `priceHistory: [{date, price, oldPrice}]` for every dish.
- `save_parquet()` serializes normalized flat records into `restaurant_dashboard/data.parquet`.
