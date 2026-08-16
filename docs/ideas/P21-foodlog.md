# Food & Weight Diary — product idea

A local-first food and body weight diary for a person who prefers a plain
spreadsheet over ad-loaded apps. Core philosophy: manual entry and manual
awareness — no barcode scanning, no food database, no accounts, no ads, no
network calls; all data in localStorage. Entries: a daily food log where each
row is date, meal name (free text), and calories (a number the user fills in
by hand, intentionally no autocomplete); rows can be added, edited and
deleted; a date picker with prev/next day navigation. Body weight: a separate
daily entry (one per date) with an optional note.

Reports (computed live from the log): (1) weekly calorie summary table — one
row per ISO week showing total calories, daily average, and days logged;
(2) monthly top-calorie dishes — for a chosen month, an aggregate list of
meals by identical free-text name, sorted by total calories descending,
showing times eaten and total, top 20; (3) weight dynamics — a line chart of
weight over time (hand-rolled SVG, no chart libraries) with weekly moving
average and min/max/first/last/change values. Data: export to CSV and import
from CSV, plus a clear-all-data button with confirmation.

Ship a single-page app, no frameworks, no backend. Acceptance is a working
page where food and weight entries persist across reloads, the three reports
compute correctly from the same log, and CSV round-trip restores the data.
