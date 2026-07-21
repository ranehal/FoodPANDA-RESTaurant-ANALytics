import httpx, json, time, random

with open("data/token.txt") as f:
    token = f.read().strip()

GRAPHQL_HASH = "e54e2da1664dea317275ce6c580b6a38b06b6a2bdf446fa1be878652a4883063"
variables = json.dumps({"input":{"code":"n2qc","expeditionType":"DELIVERY","filters":{"productRecommendationLimit":-1},"isPandaboost":False,"ignoreShrinkage":False},"isRetrieveIdOnly":True,"isVendorMiscEnabled":True,"menuInput":{"expeditionType":"DELIVERY"},"isPickup":False,"mfoFederationEnabled":False,"isShrinkageUseCase":False,"recommendationInput":{"expeditionType":"DELIVERY","isMealForOne":False},"discountedPriceInput":{"expeditionType":"DELIVERY"}})
extensions = json.dumps({"persistedQuery":{"version":1,"sha256Hash":GRAPHQL_HASH}})
headers = {"accept":"application/json","app-version":"26.28.0","device-id":"24de6ba6fb091a6d4a82735d73e61a05","user-agent":"Android-app-26.28.0(262800214)","x-fp-api-key":"android","app-name":"com.global.foodpanda.android","app-flavor":"foodpanda","platform":"android","platform-version":"36","build-type":"release","api-client-version":"5.0","x-pd-language-id":"1","authorization":f"Bearer {token}","apollo-require-preflight":"true","x-apollo-operation-name":"RestaurantDetailsPage","display-context":"RDP","customer-latitude":"23.7465","customer-longitude":"90.3742","perseus-client-id":f"{int(time.time()*1000)}.{random.randint(10**9,10**10-1)}.{random.randint(10**19,10**20-1)}","perseus-session-id":f"{int(time.time()*1000)}.{random.randint(10**19,10**20-1)}.{random.randint(10**19,10**20-1)}","dps-session-id":json.dumps({"session_id":f"{random.randint(10**21,10**22-1):x}","timestamp":int(time.time()*1000)}),"locale":"en_BD","x-global-entity-id":"FP_BD","apollographql-client-name":"android","apollographql-client-version":"26.28.0"}
params = {"operationName":"RestaurantDetailsPage","variables":variables,"extensions":extensions}

with httpx.Client(http2=False) as c:
    r = c.get("https://bd.fd-api.com/graphql", params=params, headers=headers, timeout=20)
    print("HTTP", r.status_code)
    data = r.json()
    rdp = (data.get("data") or {}).get("restaurantDetailsPage")
    if rdp:
        vd = rdp.get("vendorData", {})
        menu = vd.get("menu") or {}
        cats = menu.get("categories", [])
        print(f"OK! {len(cats)} categories")
        if cats:
            p = cats[0].get("products", [])
            if p:
                pa = p[0].get("priceAttributes", {})
                print(f"  Product: {p[0].get('title')} - {pa.get('originalPrice')} BDT")
    else:
        print("rdp is null")
        errors = data.get("errors", [])
        for e in errors:
            print(f"  Error: path={e.get('path')}, msg={e.get('message','')[:150]}")
