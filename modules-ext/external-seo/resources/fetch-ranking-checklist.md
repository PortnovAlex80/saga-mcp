# SEO Ranking Fetch Checklist

Operational checklist for the `fetch-ranking` external node.

## Pre-flight
- [ ] Campaign keywords list is non-empty and de-duplicated.
- [ ] `searchEngine` is one of the supported providers (google, bing, yandex).
- [ ] `locale` matches an active market for the campaign.
- [ ] `trackedDomain`, when present, is a resolvable hostname.

## Post-flight (ranking snapshot)
- [ ] Every requested keyword has exactly one rank entry.
- [ ] `position` is a positive integer.
- [ ] `url` is a valid URI present in the result SERP.
- [ ] `fetchedAt` is within the freshness SLA window before hand-off.
- [ ] `isTrackedDomain` is set for every entry when `trackedDomain` was requested.
