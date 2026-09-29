# Qroad

Qroad is a privacy-conscious trip-route planner for field work in Korea. It reads an Excel or CSV file in the browser, extracts only the visit-related fields after user confirmation, and sends those fields to the backend for geocoding, road-time calculation, and route planning.

Two visits and a trip length are enough to start. Everything else — existing day assignments, visit order, start, end, lodging, stay times, task counts, time notes — is used when present and never invented when absent.

## Local run

1. Copy `backend/.env.example` to `backend/.env` and set `KAKAO_REST_API_KEY`.
2. Copy `frontend/.env.example` to `frontend/.env` and set `VITE_KAKAO_MAP_KEY` after registering the local or production domain in Kakao Developers.
3. Create a Python virtual environment, install the backend, then run it:

```powershell
& 'C:\Users\SEC\AppData\Local\Programs\Python\Python313\python.exe' -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -e backend[dev]
backend\.venv\Scripts\uvicorn.exe app.main:app --app-dir backend --reload --port 8000
```

4. In another terminal, start the frontend:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Tests

```powershell
backend\.venv\Scripts\python.exe -m pytest        # run from backend\
npm test                                          # run from frontend\
```

The backend suite covers day partitioning, the route optimizer, the road-matrix
provider, time-note parsing, lodging/workload/baseline behaviour, and the API contract.
The frontend suite covers workbook parsing, the column mapping that decides which fields
ever leave the browser, error handling, and the annotated export.

## Reading arbitrary spreadsheets

No fixed template is required and no column position is hardcoded. Each sheet is scanned
for its header row, merged cells are filled down, blank separator rows are dropped, and
columns are matched by keyword — `주소`, `소재지`, `납세자주소`, `방문처`, `출장지` and
many others all resolve to the same canonical field. An address split across
`시군구` and `상세주소` is joined. Every guess is shown in the mapping UI and can be
overridden before anything is sent.

Each visit keeps the spreadsheet row it came from, so a problem can always be traced
back to a line in the user's own file.

## Privacy boundary

The browser reads the source workbook. Only the user-confirmed visit label, address, source row, optional day/order/time fields, and route settings are posted to the API. The original workbook, unrelated columns, and direct identifiers are never uploaded by this application. The backend does not log address values or API responses, and a rejected request answers with a plain sentence rather than echoing the submitted values back.

Without a Kakao REST key, the API intentionally does not fabricate coordinates. When road routing is temporarily unavailable after successful geocoding, Qroad labels its geometric travel estimates as estimates rather than road results.

## How a plan is built

1. **Geocode.** Each address goes through Kakao Local address search. A place-name
   search is only a fallback, and its result is marked `review` so the UI asks for
   confirmation instead of silently accepting it. A failed address is reported with its
   row number and candidates, never dropped.
2. **Partition (which day).** A supplied 일차 is kept as given. Remaining visits are
   assigned by coordinate proximity, with a ceiling on each day's total on-site minutes
   so a dense cluster cannot leave one day twice as long as the rest.
3. **Road matrix.** Only legs a plan can actually drive are priced: pairs within a day,
   plus that day's own anchors. Cross-day pairs are skipped, which is the difference
   between a few hundred road lookups and tens of thousands on a full trip.
4. **Order (which sequence).** OR-Tools orders each day against a trip-wide search
   budget, minimising total driving time, so the wait does not grow with the day count.

Day assignment and within-day ordering are kept as two separate problems, which is what
lets an uploaded 일차 column be honoured while the order inside it is still improved.

### Start, end and lodging

Given a lodging address, a trip is treated as a chain: day 1 leaves the start address and
finishes at the lodging, middle days begin and end there, and the last day returns to the
end address. Without lodging, every day shares the same two anchors. A city name is never
resolved into an arbitrary building — an address that cannot be geocoded produces a
warning and the plan continues without that anchor.

### Time notes

A 시간 정보 column is sorted into notes that can be checked and notes that cannot.
`13:00까지`, `오후 2시` and `09:30 방문` become real minute-of-day bounds; `오전`,
`점심 전` and anything unparsed stay descriptive. Visit order is not forced to satisfy
them — that would be a time-window problem beyond this scope — but every computed arrival
is compared against the exact ones, and a missed bound is reported against its source row.

## Result output

- **경로 계획** — one row per stop, with arrival, departure, travel time and distance,
  whether that leg was road-priced or estimated, and any time condition.
- **일차 요약** — per-day totals, anchors, stay time, task count and estimated-leg count,
  alongside the original route's time and distance.
- **확인 필요** — every visit that never reached a route, with its candidates.
- **원본+결과** — the uploaded rows exactly as they were, with `Qroad_` result columns
  appended to each, matched by spreadsheet row. This is the sheet to work from.

The UI shows the original visit sequence against the planned one, both as a list and as a
dashed line on the map, so the improvement can be checked rather than taken on trust.

## Known limits

- One request handles up to 200 visits and 31 days. The browser blocks a larger
  selection before sending it.
- Kakao's multi-destination API answers within a 10 km radius. Legs longer than that
  fall back to a distance-based estimate; those legs are counted per day and marked
  `추정` in the UI and in the exported workbook rather than being presented as road times.
- Road polylines are drawn for days of 32 points or fewer, which is the waypoint limit
  of the directions API. Longer days fall back to straight connectors between stops.
- Day assignment balances proximity against on-site minutes. It is a clear, stated rule,
  not a proven global optimum, and the UI says so rather than claiming optimality.
- Original cell formatting is not carried into the exported workbook; values are.

## Deliberately out of scope

Login, payment, multiple vehicles or drivers, a mobile app, live GPS, re-optimisation on
traffic incidents, lodging booking, offline maps, natural-language input, and LLM-based
(including local Qwen) personal-data filtering. Column selection is deliberately rule-based
and predictable. The canonical visit model and the optimisation layer are structured so
vehicle counts, time windows and per-visitor constraints can be added later without
reshaping them.
