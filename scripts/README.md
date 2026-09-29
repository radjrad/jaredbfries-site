# scripts

## cf-analytics-report.py

Prints a weekly Cloudflare Web Analytics summary for jaredbfries.com (visits, page views,
top pages, referrers, countries, devices, Core Web Vitals p75) for the last 7 days against the
7 days before.

Requires `CLOUDFLARE_API_TOKEN` in the environment. Create the token in the Cloudflare
dashboard (My Profile > API Tokens) with the permission **Account > Account Analytics > Read**.
The script finds the account and Web Analytics site on its own.

```
python3 scripts/cf-analytics-report.py            # text report
python3 scripts/cf-analytics-report.py --days 30  # longer window
python3 scripts/cf-analytics-report.py --json     # raw numbers
```

A weekly Claude routine runs this every Monday morning and sends the summary.
