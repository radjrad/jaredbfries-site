#!/usr/bin/env python3
"""Weekly Cloudflare Web Analytics report for jaredbfries.com.

Reads CLOUDFLARE_API_TOKEN from the environment (token needs Account > Account Analytics: Read).
Discovers the account and Web Analytics site automatically, then prints a plain-text summary
of the last 7 days vs the 7 days before: visits, page views, top pages, top referrers,
top countries, and Core Web Vitals (p75).

Usage: python3 scripts/cf-analytics-report.py [--days 7] [--site jaredbfries.com] [--json]
"""
import argparse, datetime as dt, json, os, sys, urllib.request

API = "https://api.cloudflare.com/client/v4"
GQL = API + "/graphql"

def token():
    t = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not t:
        sys.exit("CLOUDFLARE_API_TOKEN is not set. Add it to the environment settings (Edit > environment variables).")
    return t

def rest(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token()})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.load(r)
    if not body.get("success"):
        sys.exit("Cloudflare REST error on %s: %s" % (path, body.get("errors")))
    return body["result"]

def gql(query, variables):
    data = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(GQL, data=data, headers={
        "Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    if body.get("errors"):
        sys.exit("Cloudflare GraphQL error: " + json.dumps(body["errors"], indent=1))
    return body["data"]

def find_site(host):
    accounts = rest("/accounts")
    for acct in accounts:
        sites = rest("/accounts/%s/rum/site_info/list" % acct["id"])
        for s in sites:
            if host in (s.get("host") or "", s.get("zone_tag") or "", s.get("site_tag") or ""):
                return acct["id"], s["site_tag"], s.get("host") or host
    sys.exit("No Web Analytics site matching %r found. Is Web Analytics enabled for the site? Accounts checked: %s"
             % (host, [a.get("name") for a in accounts]))

QUERY = """
query($acct:String!, $site:String!, $since:Time!, $until:Time!) {
  viewer { accounts(filter:{accountTag:$acct}) {
    total: rumPageloadEventsAdaptiveGroups(limit:1, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}) {
      count sum { visits } }
    byDay: rumPageloadEventsAdaptiveGroups(limit:31, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}, orderBy:[date_ASC]) {
      count sum { visits } dimensions { date } }
    byPath: rumPageloadEventsAdaptiveGroups(limit:15, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}, orderBy:[count_DESC]) {
      count sum { visits } dimensions { requestPath } }
    byRef: rumPageloadEventsAdaptiveGroups(limit:10, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}, orderBy:[count_DESC]) {
      count sum { visits } dimensions { refererHost } }
    byCountry: rumPageloadEventsAdaptiveGroups(limit:10, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}, orderBy:[count_DESC]) {
      count sum { visits } dimensions { countryName } }
    byDevice: rumPageloadEventsAdaptiveGroups(limit:5, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}, orderBy:[count_DESC]) {
      count dimensions { deviceType } }
    vitals: rumWebVitalsEventsAdaptiveGroups(limit:1, filter:{siteTag:$site, datetime_geq:$since, datetime_lt:$until}) {
      count quantiles { largestContentfulPaintP75 cumulativeLayoutShiftP75 interactionToNextPaintP75 firstInputDelayP75 } }
  } }
}
"""

def window(days, end):
    start = end - dt.timedelta(days=days)
    return start.strftime("%Y-%m-%dT00:00:00Z"), end.strftime("%Y-%m-%dT00:00:00Z")

def fetch(acct, site, days, end):
    since, until = window(days, end)
    d = gql(QUERY, {"acct": acct, "site": site, "since": since, "until": until})
    return d["viewer"]["accounts"][0], since, until

def totals(a):
    t = (a.get("total") or [{}])[0]
    return t.get("count", 0), (t.get("sum") or {}).get("visits", 0)

def pct(cur, prev):
    if not prev: return "n/a"
    return "%+.0f%%" % ((cur - prev) / prev * 100)

def ms(v): return "n/a" if v is None else "%.0f ms" % v

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--site", default="jaredbfries.com")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    acct, site_tag, host = find_site(args.site)
    today = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    cur, since, until = fetch(acct, site_tag, args.days, today)
    prev, psince, puntil = fetch(acct, site_tag, args.days, today - dt.timedelta(days=args.days))

    if args.json:
        print(json.dumps({"host": host, "window": [since, until], "current": cur,
                          "previous_window": [psince, puntil], "previous": prev}, indent=1))
        return

    cv, cvis = totals(cur); pv, pvis = totals(prev)
    print("Cloudflare Web Analytics for %s" % host)
    print("Window: %s to %s (previous: %s to %s)\n" % (since[:10], until[:10], psince[:10], puntil[:10]))
    print("Visits:     %6d  (%s vs previous)" % (cvis, pct(cvis, pvis)))
    print("Page views: %6d  (%s vs previous)" % (cv, pct(cv, pv)))

    print("\nBy day:")
    for r in cur.get("byDay", []):
        print("  %s  visits %4d  views %4d" % (r["dimensions"]["date"], r["sum"]["visits"], r["count"]))

    def section(title, key, dim):
        rows = cur.get(key, [])
        if not rows: return
        print("\n%s:" % title)
        for r in rows:
            label = r["dimensions"].get(dim) or "(direct / none)"
            vis = (r.get("sum") or {}).get("visits")
            print("  %-40s views %4d%s" % (label[:40], r["count"], "" if vis is None else "  visits %4d" % vis))

    section("Top pages", "byPath", "requestPath")
    section("Top referrers", "byRef", "refererHost")
    section("Top countries", "byCountry", "countryName")
    section("Devices", "byDevice", "deviceType")

    v = (cur.get("vitals") or [{}])[0]
    q = v.get("quantiles") or {}
    if q:
        print("\nCore Web Vitals (p75, %d samples):" % v.get("count", 0))
        print("  LCP  %s   (good < 2500 ms)" % ms(q.get("largestContentfulPaintP75")))
        print("  INP  %s   (good < 200 ms)" % ms(q.get("interactionToNextPaintP75")))
        cls = q.get("cumulativeLayoutShiftP75")
        print("  CLS  %s   (good < 0.1)" % ("n/a" if cls is None else "%.3f" % cls))

if __name__ == "__main__":
    main()
